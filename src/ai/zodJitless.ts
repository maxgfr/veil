/**
 * llm-models bundles zod, whose `allowsEval` probe runs `new Function("")`:
 * under the page's Trusted Types policy that is reported as a violation. zod
 * reads `globalThis.__zod_globalConfig` when it loads, so this module must be
 * imported before "llm-models/browser" wherever that is imported. The object
 * is updated in place, so a zod already loaded (it keeps a reference and
 * probes lazily) sees it too.
 */
const g = globalThis as { __zod_globalConfig?: Record<string, unknown> };
g.__zod_globalConfig ??= {};
g.__zod_globalConfig.jitless = true;
