/** Replaced at build time by scripts/build.ts. */
declare const __E2EE_WORKER_URL__: string;
declare const __AI_WORKER_URL__: string;
declare const __PCM_WORKLET_URL__: string;
declare const __SPEECH_WORKER_URL__: string;
/** In the speech worker: ONNX Runtime's file names (npm) to the files next to the worker. */
declare const __ORT_FILES__: Readonly<Record<string, string>>;
/** In the service worker: ONNX Runtime's files, cached on first use like the speech worker. */
declare const __ORT_URLS__: string[];
declare const __SW_VERSION__: string;
declare const __PRECACHE__: string[];
