/**
 * Minimal chainable stand-in for the supabase-js query builder, sufficient for unit tests of
 * code paths that count rows and insert logs. Records every insert for assertions.
 */
export interface FakeDbOptions {
  counts?: Record<string, number>;
  single?: Record<string, unknown>;
}

export function fakeDb(opts: FakeDbOptions = {}) {
  const inserts: Array<{ table: string; row: unknown }> = [];
  const builder = (table: string) => {
    const result = { data: opts.single?.[table] ?? null, error: null, count: opts.counts?.[table] ?? 0 };
    const chain: Record<string, unknown> = {};
    const self = new Proxy(chain, {
      get(_t, prop: string) {
        if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(result);
        if (prop === 'insert') {
          return (row: unknown) => {
            inserts.push({ table, row });
            return self;
          };
        }
        return () => self;
      },
    });
    return self;
  };
  return { db: { from: builder, rpc: () => builder('rpc') } as never, inserts };
}
