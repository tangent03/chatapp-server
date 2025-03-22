class ErrorHandler extends Error {
    constructor(message, statusCode) {
      super(message);
      this.statusCode = statusCode;
    }
  }
  
  const asyncHandler = (func) => (req, res, next) => {
    Promise.resolve(func(req, res, next)).catch(next);
  };
  
  export { ErrorHandler, asyncHandler };
