export { }

declare global {
  /**
   * NOTE: Only available in Deshader Editor context
   */
  const deshader: {
    lsp?: string,
    commands?: string,
  } | undefined
}