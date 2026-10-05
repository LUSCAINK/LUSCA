// @ts-check
// SEPIA-0 core now lives in shared/sepia/ so the server, browsers and the
// desktop CLI run ONE implementation of the model math. This re-export keeps
// existing imports (worker.mjs, trainer.ts) working unchanged.
export * from '../../shared/sepia/model.mjs'
