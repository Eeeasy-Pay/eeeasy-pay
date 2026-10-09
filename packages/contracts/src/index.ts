// V1 product contracts (ADR-013). Every wire type is DERIVED from its Zod schema, so
// the runtime validation and the compile-time type cannot drift. The OpenAPI mirror
// lives in apps/api/openapi/v1.yaml and is cross-checked against these schemas in CI.
export * from './shared.ts';
export * from './problem.ts';
export * from './payment-intent.ts';
export * from './split.ts';
