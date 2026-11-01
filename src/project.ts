/**
 * The kit's public repository: the ONE place its name is written in code. package.json
 * (repository, bugs, homepage), SECURITY.md and the README link to it; test/project.test.ts fails
 * if any of them disagrees with this constant, so a rename at publish time is: change it here, run
 * the tests, fix what they name.
 */
export const REPO_SLUG = 'justypdev/mineswap-agent-kit' as const;
export const REPO_URL = `https://github.com/${REPO_SLUG}` as const;
/** GitHub private vulnerability reporting (Security → Report a vulnerability). */
export const SECURITY_REPORT_URL = `${REPO_URL}/security/advisories/new` as const;
