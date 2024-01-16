import { UnknownFunction } from './types.js'

export type RemoveIndex<T> = {
  [K in keyof T as string extends K ? never : number extends K ? never : K]: T[K]
}

export const uppercase = <S extends string>(str: S): Uppercase<S> => str.toUpperCase() as Uppercase<S>

/**
 * Convert Headers instance into regular object
 */
export const HeadersInstanceToPlainObject = (headers: Response['headers']): Record<string, string> => {
  const o: Record<string, string> = {}
  headers.forEach((v, k) => {
    o[k] = v
  })
  return o
}

export const exponentialBackoff = ({
  func,
  fallback,
  maxRetry,
  retry = 0,
  timeout,
}: {
  func: UnknownFunction
  fallback: UnknownFunction
  maxRetry: number
  retry?: number
  timeout: number
}) => {
  try {
    func()
  } catch (err) {
    if (retry < maxRetry) {
      setTimeout(
        () =>
          exponentialBackoff({
            func,
            fallback,
            maxRetry,
            retry: retry + 1,
            timeout: timeout * 2,
          }),
        timeout,
      )
    } else {
      fallback(err)
    }
  }
}
