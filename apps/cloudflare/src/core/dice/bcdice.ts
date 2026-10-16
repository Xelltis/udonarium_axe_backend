import * as LoaderModule from 'bcdice/lib/loader/loader';
import type BaseLoader from 'bcdice/lib/loader/loader';
import type { I18nJsonObject } from 'bcdice/lib/loader/loader';
import type GameSystemClass from 'bcdice/lib/game_system';

import { GAME_SYSTEM_IMPORTERS, I18N_IMPORTERS } from './bcdice-importers.generated.js';

/** CommonJS のモジュールの default。バンドルのしかたによって1段か2段になる */
export const unwrapDefault = <T>(module: { default: T | { default?: T } }): T => {
  const first = module.default as { default?: T };
  return first.default ?? (first as T);
};

const Loader = unwrapDefault(LoaderModule as unknown as { default: typeof BaseLoader });

/** 名前から読み込む表を使う loader。bcdice 同梱の DynamicLoader は、パスを実行時に組み立てるので使えない */
export class WorkerLoader extends Loader {
  override async dynamicImportI18n(baseClassName: string, locale: string): Promise<I18nJsonObject> {
    const importer = I18N_IMPORTERS[`${baseClassName}.${locale}`];
    if (!importer) throw new Error(`BCDice has no translation ${baseClassName}.${locale}`);
    // JSON のモジュールは、中身を default に持つ
    return ((await importer()) as { default: I18nJsonObject }).default;
  }

  override async dynamicImport(className: string): Promise<void> {
    const importer = GAME_SYSTEM_IMPORTERS[className];
    if (!importer) throw new Error(`BCDice has no game system ${className}`);
    await importer();
  }
}

const loader = new WorkerLoader();

/** 読み込んだシステム。bcdice は尋ねるたびにクラスを作り直すので、ここで使い回す */
const loaded = new Map<string, GameSystemClass>();

/** ゲームシステムを読み込む。読み込んだものはそのまま使い回す。知らない ID なら null */
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
