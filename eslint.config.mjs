import typescriptEslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

export default [{
  files: ["**/*.ts"],
}, {
  plugins: {
    "@typescript-eslint": typescriptEslint,
  },

  languageOptions: {
    parser: tsParser,
    ecmaVersion: 2022,
    sourceType: "module",
  },

  rules: {
    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/naming-convention": ["error", {
      selector: "import",
      format: ["camelCase", "PascalCase"],
    }],

    "arrow-parens": ["error", "as-needed"],
    "comma-dangle": ["error", "always-multiline"],
    "curly": "error",
    "eqeqeq": "error",
    "func-style": ["error", "expression"],
    "indent": ["error", 2],
    "key-spacing": ["error", { beforeColon: false, afterColon: true }],
    "no-multiple-empty-lines": ["error", { max: 1 }],
    "no-tabs": "error",
    "no-throw-literal": "error",
    "no-trailing-spaces": "error",
    "quotes": ["error", "double"],
    "semi": "error",
  },
}];
