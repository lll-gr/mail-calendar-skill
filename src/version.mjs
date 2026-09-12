// build.mjs substitutes __MAILCAL_VERSION__ with the literal it reads from package.json,
// so the published bundle does not embed the whole manifest the way a JSON import does
// (which drags the scripts and devDependencies into a shipped artifact). Running an
// unbundled entry point directly therefore reports the placeholder instead.
export const VERSION = typeof __MAILCAL_VERSION__ === 'string' ? __MAILCAL_VERSION__ : 'unbuilt';
