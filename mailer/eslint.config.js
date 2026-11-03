import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      globals: {
        crypto: "readonly",
        Request: "readonly",
        Response: "readonly"
      }
    }
  },
  {
    ignores: [".wrangler", "node_modules"]
  }
);
