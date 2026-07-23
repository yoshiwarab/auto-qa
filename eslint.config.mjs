import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "build/**",
      "dist/**",
      "node_modules/**",
      "swarmforge/scripts/**",
      "tmp/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
);
