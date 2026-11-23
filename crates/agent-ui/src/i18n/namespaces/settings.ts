// Settings page sections (providers, system tools, memory, SSH, remote access, plugins, ...).
// Only modules of lazily loaded features render these messages; each of them
// imports this file, which registers both locales before the module renders.
import { registerTranslations } from "../hostTranslations";
import { SETTINGS_EN_US } from "./settingsEnUS";
import { SETTINGS_ZH_CN } from "./settingsZhCN";

registerTranslations({ "zh-CN": SETTINGS_ZH_CN, "en-US": SETTINGS_EN_US });
