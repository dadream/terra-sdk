const MAXIMUM_METADATA_BYTES = 1024 * 1024

function responseLimit(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes <= 0)
    throw new Error('Response byte limit must be a positive safe integer')
  return bytes
}

function responseSizeError() {
  return Object.assign(new Error('Response exceeds its bounded input'),
    {code: 'response_too_large', retryable: false})
}

function binaryResponseBytes(data, maximumBytes) {
  responseLimit(maximumBytes)
  if (!(data instanceof ArrayBuffer) && !(data instanceof Uint8Array))
    throw Object.assign(new Error('Binary response must be an ArrayBuffer or Uint8Array'),
      {code: 'invalid_response', retryable: false})
  if (data.byteLength > maximumBytes) throw responseSizeError()
  return data instanceof Uint8Array ? data : new Uint8Array(data)
}

module.exports = {MAXIMUM_METADATA_BYTES, responseLimit, responseSizeError, binaryResponseBytes}
