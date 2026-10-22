import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * latentPresence's ADR-15, which this app follows: "one theme.css per app is the single source
 * of styling truth; every className used in TSX has a rule there". Copied from
 * latentPresence/apps/web/src/theme.test.ts (2026-10-22).
 *
 * Ported there from latentCreate, where it was written after three bugs of one shape landed in
 * a single day: a class with no rule at all, a panel with no bottom gap, and a class
 * keeping a margin from a position it no longer held. None of those is visible to `tsc`,
 * oxlint or vitest, and all three reached a person.
 *
 * These tests catch the kinds a machine can check: a className with no rule behind it, a
 * computed prefix nothing answers to, an exemption that has outlived its class, and a
 * colour literal outside :root.
 */

// `fileURLToPath` is given the string, not a URL object: under the jsdom environment
// the global URL is jsdom's, and node:url rejects it as not being a file URL.
const SRC = dirname(fileURLToPath(import.meta.url));

/**
 * Classes used in TSX that deliberately have no rule.
 *
 * Each entry needs a reason, and the reason must be that the element is styled by
 * something else -- a parent's flex layout, typically -- rather than that nobody got
 * round to it. A class that looks unstyled on screen belongs in theme.css, not here.
 */
const UNSTYLED_BY_DESIGN = new Map<string, string>();

/** Every `.tsx` file under `src/`, recursively. */
function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsxFiles(path);
    return entry.name.endsWith('.tsx') ? [path] : [];
  });
}

/** Every `.css` file under `src/`, recursively. */
function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return cssFiles(path);
    return entry.name.endsWith('.css') ? [path] : [];
  });
}

/**
 * Every class name a file asks for, including the ones inside a template literal's
 * interpolations.
 *
 * `${selected ? 'row-selected' : ''}` is where state classes live, so a scanner that
 * stripped interpolations wholesale would check the least-exercised half of the
 * stylesheet and miss the rest. A token left ending in `-` after stripping is a computed
 * suffix (`` `gallery-swatch-${token}` ``) and is checked as a prefix instead.
 */
export function classesIn(source: string): { exact: string[]; prefixes: string[] } {
  const exact = new Set<string>();
  const prefixes = new Set<string>();

  for (const match of source.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
    const raw = match[1] ?? match[2] ?? '';

    // Harvest the string literals inside `${...}` before dropping the rest.
    for (const interpolation of raw.matchAll(/\$\{[^}]*\}/g)) {
      for (const literal of interpolation[0].matchAll(/'([^']*)'|"([^"]*)"/g)) {
        for (const token of (literal[1] ?? literal[2] ?? '').split(/\s+/)) {
          if (/^[a-zA-Z][\w-]*$/.test(token)) exact.add(token);
        }
      }
    }

    for (const token of raw.replaceAll(/\$\{[^}]*\}/g, ' ').split(/\s+/)) {
      if (/^[a-zA-Z][\w-]*-$/.test(token)) prefixes.add(token);
      else if (/^[a-zA-Z][\w-]*$/.test(token)) exact.add(token);
    }
  }

  return { exact: [...exact], prefixes: [...prefixes] };
}

/** Every class the stylesheet defines a rule for. */
export function classesDefinedIn(css: string): Set<string> {
  return new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((match) => match[1] ?? ''));
}

/**
 * The part of a stylesheet a colour literal is not allowed in: everything but the
 * `:root` token blocks, and not the comments, which is where the palette gets explained
 * in words like "teal" and "#0a0e1a".
 */
export function styledBody(css: string): string {
  return css.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/:root\s*\{[^}]*\}/g, '');
}

const themeCss = readFileSync(join(SRC, 'theme.css'), 'utf8');

describe('theme.css covers every className', () => {
  const defined = classesDefinedIn(themeCss);

  it('has a rule for every class used in a view or component', () => {
    const missing: string[] = [];
    for (const file of tsxFiles(SRC)) {
      const { exact } = classesIn(readFileSync(file, 'utf8'));
      for (const name of exact) {
        if (defined.has(name) || UNSTYLED_BY_DESIGN.has(name)) continue;
        missing.push(`.${name} (${relative(SRC, file)})`);
      }
    }
    expect(
      missing,
      'add a rule to theme.css, or an entry with its reason to UNSTYLED_BY_DESIGN',
    ).toEqual([]);
  });

  // `` `gallery-swatch-${token}` `` is only safe if some rule answers to it.
  it('has a rule for every computed class prefix', () => {
    const orphaned: string[] = [];
    for (const file of tsxFiles(SRC)) {
      const { prefixes } = classesIn(readFileSync(file, 'utf8'));
      for (const prefix of prefixes) {
        const answered = [...defined].some((name) => name.startsWith(prefix) && name !== prefix);
        if (!answered) orphaned.push(`.${prefix}* (${relative(SRC, file)})`);
      }
    }
    expect(orphaned).toEqual([]);
  });

  // Keeps the exemption list honest: an entry that outlives its class is a licence for
  // the next unstyled one to hide behind it.
  it('carries no stale exemptions', () => {
    const used = new Set(
      tsxFiles(SRC).flatMap((file) => classesIn(readFileSync(file, 'utf8')).exact),
    );
    for (const [name] of UNSTYLED_BY_DESIGN) {
      expect(used.has(name), `${name} is exempted but no longer used`).toBe(true);
      expect(defined.has(name), `${name} is exempted but theme.css now styles it`).toBe(false);
    }
  });
});

describe('colours live only in :root', () => {
  /**
   * ADR-15 again: a literal outside the token block is a colour that cannot be
   * retuned with the rest of the palette, and the suite retunes -- it moved from
   * violet to blue in one pass, and this app is teal against the same base.
   */
  const forbidden: readonly { label: string; pattern: RegExp }[] = [
    { label: 'hex colour', pattern: /#[0-9a-fA-F]{3,8}\b/g },
    { label: 'rgb()', pattern: /\brgba?\(/g },
    { label: 'hsl()', pattern: /\bhsla?\(/g },
    // Named colours, but only in value position, so a class called .gold is fine.
    {
      label: 'named colour',
      pattern:
        /:\s*[^;{}]*\b(?:white|black|red|green|blue|yellow|orange|purple|pink|gray|grey|cyan|magenta|silver|gold|teal|navy|lime|olive|maroon|aqua|fuchsia)\b/g,
    },
  ];

  it('finds no colour literal outside a :root block', () => {
    const offences: string[] = [];
    for (const file of cssFiles(SRC)) {
      const body = styledBody(readFileSync(file, 'utf8'));
      for (const { label, pattern } of forbidden) {
        for (const match of body.matchAll(pattern)) {
          offences.push(`${label} "${match[0].trim()}" in ${relative(SRC, file)}`);
        }
      }
    }
    expect(offences, 'move the colour into a :root token and reference it with var()').toEqual([]);
  });

  it('would catch one if it appeared', () => {
    // Without this, the test above passes just as happily against a broken matcher.
    const bad = [
      ':root { --accent: #2dd4bf; }',
      '.btn { color: #ff0000; background: rgb(1, 2, 3); }',
      '.pill { border-color: hsl(0, 100%, 50%); outline-color: white; }',
    ].join('\n');
    const body = styledBody(bad);
    expect(body).not.toContain('--accent');
    for (const { label, pattern } of forbidden) {
      expect(new RegExp(pattern.source).test(body), label).toBe(true);
    }
  });

  it('ignores colours named in a comment', () => {
    // The token block is documented in prose above it, and that prose says "teal"
    // and quotes the blue it replaced. Neither is a colour anything renders.
    const documented = '/* teal, not #58a6ff, and not rgb(88, 166, 255) */\n.btn { color: var(--accent); }';
    const body = styledBody(documented);
    for (const { label, pattern } of forbidden) {
      expect(new RegExp(pattern.source).test(body), label).toBe(false);
    }
  });
});

describe('the scanner itself', () => {
  // Without these, a broken regex would make all three tests above pass on an
  // empty result set, which is exactly the failure they exist to prevent.
  it('reads exact classes, interpolated literals and computed prefixes', () => {
    const source = [
      'const a = <div className="panel panel-header" />;',
      "const b = <div className={`pill ${ok ? 'pill-ok' : 'pill-warn'}`} />;",
      'const c = <div className={`gallery-swatch-chip gallery-swatch-${token}`} />;',
    ].join('\n');

    const { exact, prefixes } = classesIn(source);
    expect(exact.toSorted()).toEqual([
      'gallery-swatch-chip',
      'panel',
      'panel-header',
      'pill',
      'pill-ok',
      'pill-warn',
    ]);
    expect(prefixes).toEqual(['gallery-swatch-']);
  });

  it('reads the classes a stylesheet defines, including state selectors', () => {
    const defined = classesDefinedIn('.btn { color: red; }\n.btn-primary:hover { }');
    expect([...defined].toSorted()).toEqual(['btn', 'btn-primary']);
  });
});
