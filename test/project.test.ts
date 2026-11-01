import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { REPO_SLUG, REPO_URL, SECURITY_REPORT_URL } from '../src/project.js';

const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const pkg = JSON.parse(read('package.json'));

describe('the public repository is named in one place (src/project.ts) and every file agrees', () => {
  it('package.json: author, repository, bugs and homepage', () => {
    expect(pkg.author).toBe('MineSwap Labs');
    expect(pkg.license).toBe('MIT');
    expect(pkg.repository).toEqual({ type: 'git', url: `git+${REPO_URL}.git` });
    expect(pkg.bugs).toEqual({ url: `${REPO_URL}/issues` });
    expect(pkg.homepage).toBe(`${REPO_URL}#readme`);
  });

  it('SECURITY.md sends reporters to GitHub private vulnerability reporting, with no email and no bounty promise', () => {
    const s = read('SECURITY.md');
    expect(s).toContain(SECURITY_REPORT_URL);
    expect(s).toMatch(/Security\*\* tab and choose \*\*Report a vulnerability/);
    expect(s).toMatch(/do not open a public issue/);
    expect(s).toMatch(/within a few days/);
    expect(s).toMatch(/no bug bounty/);
    expect(s).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}|mailto:|PLACEHOLDER|to be filled in/i);
    for (const part of ['the guard', 'the signers', 'the CDP wallet policy template', 'the MCP tools']) expect(s).toContain(part);
  });

  it('LICENSE names MineSwap Labs, 2026', () => {
    expect(read('LICENSE')).toMatch(/^MIT License\n\nCopyright \(c\) 2026 MineSwap Labs\n/);
  });

  it('every GitHub repository link in the published files is this one', () => {
    for (const f of ['package.json', 'README.md', 'SECURITY.md']) {
      const slugs = [...read(f).matchAll(/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git|[/#)\s"]|$)/g)].map((m) => m[1]);
      expect(slugs.length, f).toBeGreaterThan(0);
      for (const s of slugs) expect(s, f).toBe(REPO_SLUG);
    }
  });
});
