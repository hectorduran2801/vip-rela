/** p-limit mínimo: como mucho `n` tareas a la vez. */
export function createLimit(n: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => { active--; queue.shift()?.(); };
  return function limit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        active++;
        fn().then(resolve, reject).finally(next);
      };
      if (active < n) run(); else queue.push(run);
    });
  };
}
