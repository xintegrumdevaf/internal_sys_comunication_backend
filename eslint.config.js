import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "coverage/**", "scripts/**"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["src/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.node,
    },
    rules: {
      // --- Clean Code & Principio de Responsabilidad Única (SRP) ---
      "max-lines": [
        "warn",
        {
          max: 400,
          skipBlankLines: true,
          skipComments: true,
        },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "warn",
        {
          prefer: "type-imports",
          fixStyle: "inline-type-imports",
        },
      ],
      // Forzar logging estructurado (Pino logger) en lugar de console.log huérfano
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "no-duplicate-imports": "warn",
      "no-debugger": "error",
      "prefer-const": "warn",
      "no-useless-assignment": "warn",
      "no-useless-escape": "warn",
    },
  },
  {
    // El Composition Root es el ensamblador central de inyección de dependencias
    files: ["src/core/composition/container.ts"],
    rules: {
      "max-lines": "off",
    },
  },
  {
    // Los adaptadores de logging por consola necesitan emitir console.log directamente
    files: ["src/shared/logging/**"],
    rules: {
      "no-console": "off",
    },
  },
);
