import * as LoaderModule from 'bcdice/lib/loader/loader.js';
import type BaseLoader from 'bcdice/lib/loader/loader.js';
import type { I18nJsonObject, getGameSystemClass } from 'bcdice/lib/loader/loader.js';

import { GAME_SYSTEM_IMPORTERS, I18N_IMPORTERS } from './bcdice-importers.generated.js';

/**
 * A game system's class. It is taken from what the function exported by name returns (the type
 * exported as default turns into the CommonJS module itself under the Vercel version's Node
 * resolution).
 */
type GameSystemClass = ReturnType<typeof getGameSystemClass>;

/** The default of a CommonJS module. It is one or two levels deep, depending on how it is bundled. */
export const unwrapDefault = <T>(module: { default: T | { default?: T } }): T => {
  const first = module.default as { default?: T };
  return first.default ?? (first as T);
};

const Loader = unwrapDefault(LoaderModule as unknown as { default: typeof BaseLoader });

/**
 * A loader that uses the tables of what to load for each name. The DynamicLoader that comes with
 * bcdice cannot be used, since it builds its paths at run time.
 */
export class WorkerLoader extends Loader {
  override async dynamicImportI18n(baseClassName: string, locale: string): Promise<I18nJsonObject> {
    const importer = I18N_IMPORTERS[`${baseClassName}.${locale}`];
    if (!importer) throw new Error(`BCDice has no translation ${baseClassName}.${locale}`);
    // A JSON module holds its contents in default.
    return ((await importer()) as { default: I18nJsonObject }).default;
  }

  override async dynamicImport(className: string): Promise<void> {
    const importer = GAME_SYSTEM_IMPORTERS[className];
    if (!importer) throw new Error(`BCDice has no game system ${className}`);
    await importer();
  }
}

const loader = new WorkerLoader();

/** The systems loaded. bcdice makes the class anew each time it is asked, so they are reused here. */
const loaded = new Map<string, GameSystemClass>();

/** Loads a game system. One already loaded is reused as it is. Null for an id it does not know. */
export const loadGameSystem = async (id: string): Promise<GameSystemClass | null> => {
  const known = loaded.get(id);
  if (known) return known;
  try {
    const system = await loader.dynamicLoad(id);
    loaded.set(id, system);
    return system;
  } catch {
    return null;
  }
};
