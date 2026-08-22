/**
 * Whether the passwordless test-login provider should be registered. Gated on an exact
 * "1" rather than any truthy string: a stray `ALLOW_TEST_LOGIN=false` in a deployed
 * environment must not enable it.
 */
export function testLoginEnabled(env: Partial<NodeJS.ProcessEnv> = process.env): boolean {
  return env.ALLOW_TEST_LOGIN === "1";
}
