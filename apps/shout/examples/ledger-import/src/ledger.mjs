// Adds newly imported transactions to the ledger.
export function mergeImports(existing, incoming) {
  return [...existing, ...incoming];
}
