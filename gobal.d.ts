export { }

declare global {
  var deshader: {
    [protocol: string]: {
      host: string,
      port: number
    },
  } | undefined
}