/** What the test file running has opened, to be closed once it is done (test/setup.ts). */
const open = new Set<() => Promise<void>>();

/** Has close called once the test file running is done. */
export const closeWhenDone = (close: () => Promise<void>): void => {
  open.add(close);
};

/** Closes what the test file that ran opened. */
export const closeAll = async (): Promise<void> => {
  const closing = [...open];
  open.clear();
  await Promise.all(closing.map((close) => close()));
};
