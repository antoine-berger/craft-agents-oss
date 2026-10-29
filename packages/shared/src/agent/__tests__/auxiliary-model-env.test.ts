import { expect, it } from 'bun:test';
import { buildClaudeSubprocessEnv, getAuxiliaryModelEnv } from '../options';
it('pins both web-tool model selectors per session, overriding another session or SDK legacy defaults', () => {
  const original = process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
  try {
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'legacy-default';
    const a = getAuxiliaryModelEnv('configured-mini-a');
    const b = getAuxiliaryModelEnv('configured-mini-b');
    const first = buildClaudeSubprocessEnv({ ANTHROPIC_SMALL_FAST_MODEL: 'wrong-global', ...a }, false);
    const second = buildClaudeSubprocessEnv(b, false);
    expect(first.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('configured-mini-a');
    expect(first.ANTHROPIC_SMALL_FAST_MODEL).toBe('configured-mini-a');
    expect(second.ANTHROPIC_SMALL_FAST_MODEL).toBe('configured-mini-b');
    expect(process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('legacy-default');
    expect(getAuxiliaryModelEnv()).toEqual({});
  } finally {
    if (original === undefined) delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
    else process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = original;
  }
});
