import { hasFlag, listFlag, numberFlag } from './curated-script-context';

/** Replaces process.argv for one assertion, the way a real CLI invocation would look. */
function withArgv<T>(args: string[], assertion: () => T): T {
  const original = process.argv;
  process.argv = ['/usr/bin/node', '/app/src/scripts/curated-process.ts', ...args];
  try {
    return assertion();
  } finally {
    process.argv = original;
  }
}

describe('CLI-флаги скриптов пула', () => {
  it('numberFlag читает "--limit N" и "--limit=N"', () => {
    withArgv(['--limit', '25'], () => expect(numberFlag('limit')).toBe(25));
    withArgv(['--limit=25'], () => expect(numberFlag('limit')).toBe(25));
  });

  it('numberFlag возвращает undefined, когда флага нет', () => {
    // Регрессия: без проверки indexOf === -1 отсюда возвращался argv[0] — путь к node.
    withArgv([], () => expect(numberFlag('limit')).toBeUndefined());
    withArgv(['--force'], () => expect(numberFlag('limit')).toBeUndefined());
  });

  it('numberFlag игнорирует не-число и не-положительное значение', () => {
    withArgv(['--limit', 'abc'], () => expect(numberFlag('limit')).toBeUndefined());
    withArgv(['--limit', '0'], () => expect(numberFlag('limit')).toBeUndefined());
    withArgv(['--limit', '-5'], () => expect(numberFlag('limit')).toBeUndefined());
  });

  it('listFlag читает список хостов в обеих формах', () => {
    withArgv(['--hosts', 'a.example,b.example'], () => expect(listFlag('hosts')).toEqual(['a.example', 'b.example']));
    withArgv(['--hosts=a.example, b.example'], () => expect(listFlag('hosts')).toEqual(['a.example', 'b.example']));
  });

  it('listFlag возвращает undefined, когда флага нет — а не путь к node', () => {
    withArgv([], () => expect(listFlag('hosts')).toBeUndefined());
    withArgv(['--force'], () => expect(listFlag('hosts')).toBeUndefined());
  });

  it('флаг, за которым сразу идёт другой флаг, не съедает его как значение', () => {
    withArgv(['--hosts', '--force'], () => expect(listFlag('hosts')).toBeUndefined());
    withArgv(['--limit', '--force'], () => expect(numberFlag('limit')).toBeUndefined());
  });

  it('hasFlag определяет переключатели', () => {
    withArgv(['--force', '--retry-failed'], () => {
      expect(hasFlag('force')).toBe(true);
      expect(hasFlag('retry-failed')).toBe(true);
      expect(hasFlag('show-problems')).toBe(false);
    });
  });
});
