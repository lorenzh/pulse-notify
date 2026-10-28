import base from "@lorenzh/pulse-config/eslint.config.js";

// The Factory runner clones other repositories into .repos/; they are not part of this lint.
export default [{ ignores: [".repos/**"] }, ...base];
