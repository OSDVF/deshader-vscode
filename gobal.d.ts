export {}

declare global {
  var deshader: {
    [protocol: string] : {
      address: string,
      port: number
    }
  } | undefined;
}