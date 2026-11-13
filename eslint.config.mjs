import eslint from "@eslint/js";
import typescript from "typescript-eslint";

export default typescript.config(
  {
    ignores: [
      "dist/**",
      "build/**",
      ".venv/**",
      "docs/_build/**",
      "node_modules/**",
    ],
  },
  eslint.configs.recommended,
  ...typescript.configs.recommended,
);
