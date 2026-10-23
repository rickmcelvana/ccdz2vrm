// ufbx -> contract (docs/BROWSER-PORT.md s2): the FBX as the reference harness compares it.
//
// Built to WASM by build.sh (zig cc, wasm32-wasi reactor). The page calls:
//   ccdz_alloc(n) -> ptr; copy the FBX in; ccdz_load(ptr, n) -> 0 ok / 1 error
//   ccdz_json() / ccdz_bin() / ccdz_bin_size() / ccdz_error(); ccdz_reset()
//
// Contract, all in the glTF frame (Y up, +Z front, metres), at the bind pose:
//   bones:  name, parent, world rest matrix (column-major) -- from the skin cluster's
//           bind_to_world, else the scene bind pose, else node_to_world
//   meshes: one per mesh instance; vertices split per (position, uv) pair like a glTF
//           export; position f32x3, uv f32x2, joints u16x8 + weights f32x8 (top 8, into
//           `bones`), triangle indices u32x3, triangle material u16, and every blend
//           channel's full-weight shape as f32x3 deltas per split vertex
//   images: embedded content, identified by fnv1a() below (dump_contract.py hashes the same)

#include "ufbx.h"
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define EXPORT(name) __attribute__((export_name(name)))
#define MAXW 8

typedef struct { char *p; size_t n, cap; } buf;

static buf J, B;
static char err[1024];

static void put(buf *b, const void *d, size_t n) {
	if (b->n + n > b->cap) {
		size_t c = b->cap ? b->cap : 1 << 16;
		while (c < b->n + n) c *= 2;
		b->p = realloc(b->p, c);
		b->cap = c;
	}
	memcpy(b->p + b->n, d, n);
	b->n += n;
}
static void js(const char *s) { put(&J, s, strlen(s)); }
static void jf(const char *fmt, double v) { char t[64]; snprintf(t, sizeof t, fmt, v); js(t); }
static void ju(size_t v) { char t[32]; snprintf(t, sizeof t, "%zu", v); js(t); }
static void jstr(const char *s, size_t n) {
	js("\"");
	for (size_t i = 0; i < n; i++) {
		unsigned char c = (unsigned char)s[i];
		if (c == '"' || c == '\\') { char e[2] = {'\\', (char)c}; put(&J, e, 2); }
		else if (c < 0x20) { char e[8]; snprintf(e, sizeof e, "\\u%04x", c); js(e); }
		else put(&J, &c, 1);
	}
	js("\"");
}
// Binary arrays are 4-byte aligned; returns the byte offset.
static size_t bin(const void *d, size_t n) {
	while (B.n % 4) { char z = 0; put(&B, &z, 1); }
	size_t off = B.n;
	put(&B, d, n);
	return off;
}

// FNV-1a 64 over the length (8 bytes LE), the first and the last 64 KB: identifies an
// image without hashing megabytes in Python (dump_contract.py does the same).
static uint64_t fnv1a(const void *d, size_t n) {
	const unsigned char *p = d;
	uint64_t h = 1469598103934665603ull;
	for (int i = 0; i < 8; i++) { h ^= ((uint64_t)n >> (8 * i)) & 0xff; h *= 1099511628211ull; } // size_t is 32-bit in wasm32
	size_t head = n < 65536 ? n : 65536;
	for (size_t i = 0; i < head; i++) { h ^= p[i]; h *= 1099511628211ull; }
	size_t tail = n - head < 65536 ? n - head : 65536;
	for (size_t i = n - tail; i < n; i++) { h ^= p[i]; h *= 1099511628211ull; }
	return h;
}

static void jmat(ufbx_matrix m) {
	// ufbx_matrix is 4 columns of vec3 (affine); write a column-major 4x4
	js("[");
	for (int c = 0; c < 4; c++)
		for (int r = 0; r < 4; r++) {
			double v = r < 3 ? m.cols[c].v[r] : (c == 3 ? 1.0 : 0.0);
			jf("%.9g", v);
			if (c * 4 + r < 15) js(",");
		}
	js("]");
}

// --- split-vertex hash: (position index, uv index) -> split id ---------------------------
typedef struct { uint64_t key; uint32_t id; } slot;
static slot *H;
static size_t HCAP;
static uint32_t hget(uint64_t key, uint32_t next, int *fresh) {
	size_t i = (size_t)(key * 0x9E3779B97F4A7C15ull) & (HCAP - 1);
	for (;;) {
		if (H[i].key == UINT64_MAX) { H[i].key = key; H[i].id = next; *fresh = 1; return next; }
		if (H[i].key == key) { *fresh = 0; return H[i].id; }
		i = (i + 1) & (HCAP - 1);
	}
}

static ufbx_scene *scene;
static char *is_bone;

// The FBX material properties Blender's importer reads (blen_read_material), as they are in
// this element's own Properties70 or its template: the cleanup applies Blender's rules.
static const char *PROPS[] = {"DiffuseColor", "SpecularFactor", "Shininess", "ShininessExponent",
	"TransparencyFactor", "Opacity", "TransparentColor", "ReflectionFactor", "BumpFactor",
	"EmissiveFactor", "EmissiveColor"};
static void jprops(const ufbx_props *props) {
	js("{");
	int first = 1;
	for (size_t i = 0; i < props->props.count; i++) {
		const ufbx_prop *p = &props->props.data[i];
		int want = 0;
		for (size_t k = 0; k < sizeof PROPS / sizeof *PROPS; k++) want |= strcmp(p->name.data, PROPS[k]) == 0;
		if (!want) continue;
		if (!first) js(",");
		first = 0;
		jstr(p->name.data, p->name.length);
		js(":[");
		for (int k = 0; k < 4; k++) { jf("%.9g", p->value_real_arr[k]); if (k < 3) js(","); }
		js("]");
	}
	js("}");
}

static int bone_index(ufbx_scene *s, const ufbx_node *n, uint32_t *bone_of_node) {
	return n ? (int)bone_of_node[n->typed_id] : -1;
}

static void write_mesh(ufbx_scene *s, ufbx_node *node, uint32_t *bone_of_node, int *first) {
	ufbx_mesh *m = node->mesh;
	ufbx_skin_deformer *skin = m->skin_deformers.count ? m->skin_deformers.data[0] : NULL;
	// geometry -> world at the bind pose
	ufbx_matrix g2w = node->geometry_to_world;
	if (skin && skin->clusters.count) {
		ufbx_skin_cluster *c = skin->clusters.data[0];
		g2w = ufbx_matrix_mul(&c->bind_to_world, &c->geometry_to_bone);
	}
	ufbx_matrix lin = g2w;
	lin.cols[3].x = lin.cols[3].y = lin.cols[3].z = 0;

	HCAP = 1;
	while (HCAP < m->num_indices * 2 + 16) HCAP *= 2;
	H = malloc(HCAP * sizeof(slot));
	for (size_t i = 0; i < HCAP; i++) H[i].key = UINT64_MAX;

	uint32_t *split_of_index = malloc(m->num_indices * sizeof(uint32_t));
	uint32_t *pos_of_split = malloc(m->num_indices * sizeof(uint32_t));
	uint32_t *idx_of_split = malloc(m->num_indices * sizeof(uint32_t));
	uint32_t nsplit = 0;
	for (size_t i = 0; i < m->num_indices; i++) {
		uint32_t pv = m->vertex_indices.data[i];
		uint32_t uv = m->vertex_uv.exists ? m->vertex_uv.indices.data[i] : 0;
		int fresh;
		uint32_t id = hget(((uint64_t)pv << 32) | uv, nsplit, &fresh);
		if (fresh) { pos_of_split[nsplit] = pv; idx_of_split[nsplit] = (uint32_t)i; nsplit++; }
		split_of_index[i] = id;
	}

	float *P = malloc(nsplit * 12), *UV = malloc(nsplit * 8);
	for (uint32_t v = 0; v < nsplit; v++) {
		ufbx_vec3 p = ufbx_transform_position(&g2w, m->vertices.data[pos_of_split[v]]);
		P[v * 3] = (float)p.x; P[v * 3 + 1] = (float)p.y; P[v * 3 + 2] = (float)p.z;
		ufbx_vec2 t = m->vertex_uv.exists ? ufbx_get_vertex_vec2(&m->vertex_uv, idx_of_split[v]) : (ufbx_vec2){0, 0};
		UV[v * 2] = (float)t.x; UV[v * 2 + 1] = (float)t.y;
	}

	uint16_t *JN = calloc(nsplit * MAXW, 2);
	float *WT = calloc(nsplit * MAXW, 4);
	if (skin) {
		for (uint32_t v = 0; v < nsplit; v++) {
			ufbx_skin_vertex sv = skin->vertices.data[pos_of_split[v]];
			// keep the MAXW largest
			for (uint32_t k = 0; k < sv.num_weights; k++) {
				ufbx_skin_weight w = skin->weights.data[sv.weight_begin + k];
				int b = bone_index(s, skin->clusters.data[w.cluster_index]->bone_node, bone_of_node);
				if (b < 0) continue;
				int slot_i = -1;
				for (int q = 0; q < MAXW; q++) if (slot_i < 0 || WT[v * MAXW + q] < WT[v * MAXW + slot_i]) slot_i = q;
				if ((float)w.weight > WT[v * MAXW + slot_i]) { WT[v * MAXW + slot_i] = (float)w.weight; JN[v * MAXW + slot_i] = (uint16_t)b; }
			}
		}
	}

	size_t ntri = 0;
	uint32_t *T = malloc(m->num_triangles * 12 + 12);
	uint16_t *TM = malloc(m->num_triangles * 2 + 2);
	uint32_t *tmp = malloc(m->max_face_triangles * 3 * sizeof(uint32_t) + 12);
	for (size_t f = 0; f < m->num_faces; f++) {
		ufbx_face face = m->faces.data[f];
		uint32_t nt = ufbx_triangulate_face(tmp, m->max_face_triangles * 3, m, face);
		for (uint32_t t = 0; t < nt; t++) {
			for (int c = 0; c < 3; c++) T[ntri * 3 + c] = split_of_index[tmp[t * 3 + c]];
			TM[ntri] = (uint16_t)(m->face_material.count ? m->face_material.data[f] : 0);
			ntri++;
		}
	}

	if (!*first) js(",");
	*first = 0;
	js("{\"name\":"); jstr(node->name.data, node->name.length);
	js(",\"node\":"); ju(node->typed_id);
	js(",\"mesh\":"); jstr(m->name.data, m->name.length);
	js(",\"vertex_count\":"); ju(nsplit);
	js(",\"triangle_count\":"); ju(ntri);
	js(",\"position\":"); ju(bin(P, nsplit * 12));
	js(",\"uv\":"); ju(bin(UV, nsplit * 8));
	js(",\"vertex\":"); ju(bin(pos_of_split, nsplit * 4)); // the logical vertex of each split vertex
	js(",\"joints\":"); ju(bin(JN, nsplit * MAXW * 2));
	js(",\"weights\":"); ju(bin(WT, nsplit * MAXW * 4));
	js(",\"indices\":"); ju(bin(T, ntri * 12));
	js(",\"triangle_material\":"); ju(bin(TM, ntri * 2));
	js(",\"clusters\":[");
	for (size_t c = 0; skin && c < skin->clusters.count; c++) {
		if (c) js(",");
		int b = bone_index(s, skin->clusters.data[c]->bone_node, bone_of_node);
		char t[16]; snprintf(t, sizeof t, "%d", b); js(t);
	}
	// the nearest bone above the mesh node: where a bone-less prop hangs (import_fbx_clean 4)
	int hang = -1;
	for (ufbx_node *a = node->parent; a && hang < 0; a = a->parent)
		if (is_bone[a->typed_id]) hang = (int)bone_of_node[a->typed_id];
	{ char t[16]; snprintf(t, sizeof t, "%d", hang); js("],\"hang_bone\":"); js(t); }
	js(",\"materials\":[");
	for (size_t i = 0; i < m->materials.count; i++) {
		if (i) js(",");
		ufbx_material *mt = m->materials.data[i];
		jstr(mt->name.data, mt->name.length);
	}
	// names repeat (two CC materials called Hair_Transparency), so also by index
	js("],\"material_index\":[");
	for (size_t i = 0; i < m->materials.count; i++) {
		if (i) js(",");
		ju(m->materials.data[i]->typed_id);
	}
	js("],\"morphs\":[");
	int fm = 1;
	float *D = malloc(nsplit * 12);
	for (size_t d = 0; d < m->blend_deformers.count; d++) {
		ufbx_blend_deformer *bd = m->blend_deformers.data[d];
		for (size_t c = 0; c < bd->channels.count; c++) {
			ufbx_blend_channel *ch = bd->channels.data[c];
			ufbx_blend_shape *sh = ch->target_shape;
			if (!sh) continue;
			// logical-vertex deltas, then fanned out to split vertices
			ufbx_vec3 *dv = calloc(m->num_vertices, sizeof(ufbx_vec3));
			for (size_t o = 0; o < sh->num_offsets; o++) {
				uint32_t v = sh->offset_vertices.data[o];
				if (v < m->num_vertices) dv[v] = ufbx_transform_position(&lin, sh->position_offsets.data[o]);
			}
			for (uint32_t v = 0; v < nsplit; v++) {
				ufbx_vec3 x = dv[pos_of_split[v]];
				D[v * 3] = (float)x.x; D[v * 3 + 1] = (float)x.y; D[v * 3 + 2] = (float)x.z;
			}
			free(dv);
			if (!fm) js(",");
			fm = 0;
			js("{\"name\":"); jstr(ch->name.data, ch->name.length);
			js(",\"shape\":"); jstr(sh->name.data, sh->name.length);
			js(",\"inbetweens\":"); ju(ch->keyframes.count ? ch->keyframes.count - 1 : 0);
			js(",\"delta\":"); ju(bin(D, nsplit * 12));
			js("}");
		}
	}
	js("]}");
	free(D); free(P); free(UV); free(JN); free(WT); free(T); free(TM); free(tmp);
	free(split_of_index); free(pos_of_split); free(idx_of_split); free(H);
}


EXPORT("ccdz_alloc") void *ccdz_alloc(size_t n) { return malloc(n); }
EXPORT("ccdz_free") void ccdz_free(void *p) { free(p); }
EXPORT("ccdz_json") const char *ccdz_json(void) { return J.p; }
EXPORT("ccdz_json_size") size_t ccdz_json_size(void) { return J.n; }
EXPORT("ccdz_bin") const char *ccdz_bin(void) { return B.p; }
EXPORT("ccdz_bin_size") size_t ccdz_bin_size(void) { return B.n; }
EXPORT("ccdz_error") const char *ccdz_error(void) { return err; }

EXPORT("ccdz_reset") void ccdz_reset(void) {
	if (scene) ufbx_free_scene(scene);
	scene = NULL;
	free(J.p); free(B.p);
	memset(&J, 0, sizeof J); memset(&B, 0, sizeof B);
}

// Parse only, no contract: what the converter itself will pay (the contract writes every
// morph densely -- 350 MB for Alice -- which is the harness's cost, not the parser's).
EXPORT("ccdz_parse_only") int ccdz_parse_only(const void *data, size_t size) {
	ccdz_reset();
	ufbx_load_opts opts = {0};
	opts.target_axes = ufbx_axes_right_handed_y_up;
	opts.target_unit_meters = 1.0f;
	opts.space_conversion = UFBX_SPACE_CONVERSION_MODIFY_GEOMETRY;
	opts.ignore_animation = true;
	ufbx_error e;
	scene = ufbx_load_memory(data, size, &opts, &e);
	if (!scene) { ufbx_format_error(err, sizeof err, &e); return 1; }
	return 0;
}

EXPORT("ccdz_load") int ccdz_load(const void *data, size_t size) {
	ccdz_reset();
	ufbx_load_opts opts = {0};
	opts.target_axes = ufbx_axes_right_handed_y_up;
	opts.target_unit_meters = 1.0f;
	opts.space_conversion = UFBX_SPACE_CONVERSION_MODIFY_GEOMETRY;
	opts.ignore_animation = true;
	ufbx_error e;
	scene = ufbx_load_memory(data, size, &opts, &e);
	if (!scene) {
		ufbx_format_error(err, sizeof err, &e);
		return 1;
	}

	// bones: every node that is a bone or a skin cluster's bone
	uint32_t *bone_of_node = malloc(scene->nodes.count * sizeof(uint32_t));
	is_bone = calloc(scene->nodes.count, 1);
	ufbx_matrix *rest = calloc(scene->nodes.count, sizeof(ufbx_matrix));
	char *have = calloc(scene->nodes.count, 1);
	for (size_t i = 0; i < scene->nodes.count; i++) if (scene->nodes.data[i]->bone) is_bone[i] = 1;
	for (size_t i = 0; i < scene->skin_clusters.count; i++) {
		ufbx_skin_cluster *c = scene->skin_clusters.data[i];
		if (!c->bone_node) continue;
		uint32_t t = c->bone_node->typed_id;
		is_bone[t] = 1;
		if (!have[t]) { rest[t] = c->bind_to_world; have[t] = 2; }
	}
	for (size_t p = 0; p < scene->poses.count; p++) {
		ufbx_pose *ps = scene->poses.data[p];
		if (!ps->is_bind_pose) continue;
		for (size_t k = 0; k < ps->bone_poses.count; k++) {
			uint32_t t = ps->bone_poses.data[k].bone_node->typed_id;
			if (is_bone[t] && !have[t]) { rest[t] = ps->bone_poses.data[k].bone_to_world; have[t] = 1; }
		}
	}
	js("{\"source\":\"ufbx\",\"ufbx_version\":\"");
	ju(UFBX_HEADER_VERSION / 1000000); js("."); ju(UFBX_HEADER_VERSION / 1000 % 1000); js("."); ju(UFBX_HEADER_VERSION % 1000);
	js("\",\"bones\":[");
	uint32_t nb = 0;
	for (size_t i = 0; i < scene->nodes.count; i++) bone_of_node[i] = is_bone[i] ? nb++ : UINT32_MAX;
	nb = 0;
	for (size_t i = 0; i < scene->nodes.count; i++) {
		if (!is_bone[i]) continue;
		ufbx_node *n = scene->nodes.data[i];
		if (nb) js(",");
		js("{\"name\":"); jstr(n->name.data, n->name.length);
		js(",\"parent\":");
		if (n->parent && !n->parent->is_root) jstr(n->parent->name.data, n->parent->name.length); else js("null");
		// names repeat (Daz skeleton copies), so the parent is also given by index
		{ char t[16]; snprintf(t, sizeof t, "%d", n->parent && is_bone[n->parent->typed_id] ? (int)bone_of_node[n->parent->typed_id] : -1);
		  js(",\"parent_index\":"); js(t); }
		js(",\"armature\":");
		{
			ufbx_node *a = n->parent;
			while (a && is_bone[a->typed_id]) a = a->parent;
			if (a && !a->is_root) jstr(a->name.data, a->name.length); else js("null");
		}
		js(",\"rest_from\":\""); js(have[i] == 2 ? "cluster" : have[i] == 1 ? "bind_pose" : "node"); js("\"");
		js(",\"matrix\":"); jmat(have[i] ? rest[i] : n->node_to_world);
		js("}");
		nb++;
	}
	// every node, with its FBX type: the cleanup applies Blender's bone/armature rule to
	// these (import_fbx.py find_armatures / find_fake_bones), not to `bones` above
	js("],\"nodes\":[");
	int firstn = 1;
	for (size_t i = 0; i < scene->nodes.count; i++) {
		ufbx_node *n = scene->nodes.data[i];
		if (n->is_root) continue;
		if (!firstn) js(",");
		firstn = 0;
		js("{\"name\":"); jstr(n->name.data, n->name.length);
		js(",\"id\":"); ju(n->typed_id);
		{ char t[16]; snprintf(t, sizeof t, "%d", n->parent && !n->parent->is_root ? (int)n->parent->typed_id : -1); js(",\"parent\":"); js(t); }
		js(",\"type\":\"");
		js(n->bone ? (n->bone->is_root ? "root" : "limb") : n->mesh ? "mesh" : n->attrib_type == UFBX_ELEMENT_EMPTY || !n->attrib ? "null" : "other");
		js("\"");
		{ char t[16]; snprintf(t, sizeof t, "%d", is_bone[i] ? (int)bone_of_node[i] : -1); js(",\"bone\":"); js(t); }
		js(",\"matrix\":"); jmat(have[i] ? rest[i] : n->node_to_world);
		js("}");
	}
	js("],\"meshes\":[");
	int first = 1;
	for (size_t i = 0; i < scene->nodes.count; i++)
		if (scene->nodes.data[i]->mesh) write_mesh(scene, scene->nodes.data[i], bone_of_node, &first);
	js("],\"materials\":[");
	for (size_t i = 0; i < scene->materials.count; i++) {
		ufbx_material *mt = scene->materials.data[i];
		if (i) js(",");
		js("{\"name\":"); jstr(mt->name.data, mt->name.length);
		js(",\"props\":"); jprops(&mt->props);
		js(",\"template\":"); if (mt->props.defaults) jprops(mt->props.defaults); else js("{}");
		js(",\"textures\":[");
		for (size_t k = 0; k < mt->textures.count; k++) {
			ufbx_material_texture *mtx = &mt->textures.data[k];
			ufbx_texture *tx = mtx->texture;
			if (k) js(",");
			js("{\"prop\":"); jstr(mtx->material_prop.data, mtx->material_prop.length);
			js(",\"file\":"); jstr(tx->relative_filename.data, tx->relative_filename.length);
			js(",\"bytes\":"); ju(tx->content.size);
			char h[24]; snprintf(h, sizeof h, "%016llx", (unsigned long long)fnv1a(tx->content.data, tx->content.size));
			js(",\"fnv\":\""); js(h); js("\"");
			js(",\"image\":"); { char t[16]; snprintf(t, sizeof t, "%d", tx->video ? (int)tx->video->typed_id : -1); js(t); }
			js("}");
		}
		js("]}");
	}
	// every Texture element: Blender names its images after these (blen_read_texture_image:
	// image.name = basename(element name)); adapt_cc looks up `<material>_Opacity` by it
	js("],\"texture_elements\":[");
	for (size_t i = 0; i < scene->textures.count; i++) {
		ufbx_texture *tx = scene->textures.data[i];
		if (i) js(",");
		js("{\"name\":"); jstr(tx->name.data, tx->name.length);
		js(",\"file\":"); jstr(tx->relative_filename.data, tx->relative_filename.length);
		char h[24]; snprintf(h, sizeof h, "%016llx", (unsigned long long)fnv1a(tx->content.data, tx->content.size));
		js(",\"fnv\":\""); js(h); js("\"}");
	}
	js("],\"images\":[");
	for (size_t i = 0; i < scene->videos.count; i++) {
		ufbx_video *v = scene->videos.data[i];
		if (i) js(",");
		js("{\"name\":"); jstr(v->relative_filename.data, v->relative_filename.length);
		js(",\"bytes\":"); ju(v->content.size);
		char h[24]; snprintf(h, sizeof h, "%016llx", (unsigned long long)fnv1a(v->content.data, v->content.size));
		js(",\"fnv\":\""); js(h); js("\"");
		js(",\"data\":"); ju(v->content.size ? bin(v->content.data, v->content.size) : 0);
		js("}");
	}
	js("]}");
	char z = 0;
	put(&J, &z, 1);
	J.n--;
	free(bone_of_node); free(is_bone); is_bone = NULL; free(rest); free(have);
	return 0;
}
