/**
 * Minimal ambient typings for express 5 — express ships none, and P2 step 2's
 * collision contract limits package.json changes to `dependencies`, so
 * @types/express cannot be added. Declares only the surface this codebase
 * uses; extend alongside any new express API adoption (must match express@5).
 */
declare module 'express' {
  import type { IncomingMessage, Server, ServerResponse } from 'node:http';

  function express(): express.Application;

  namespace express {
    /** Handler request: express adds `query`/`path`/`baseUrl` over the raw message. */
    interface Request extends IncomingMessage {
      readonly query: Record<string, unknown>;
      /** Path within the mount (`app.use('/api', …)` strips the prefix). */
      readonly path: string;
      /** Mount path (`/api` inside a mounted handler). */
      readonly baseUrl: string;
    }

    interface Response extends ServerResponse {
      status(code: number): Response;
      json(body: unknown): Response;
      send(body?: unknown): Response;
      /** Absolute path required; transfer errors go to the error handler. */
      sendFile(absolutePath: string): void;
    }

    interface NextFunction {
      (error?: unknown): void;
    }

    type RequestHandler = (req: Request, res: Response, next: NextFunction) => unknown;

    interface Application {
      use(...handlers: RequestHandler[]): Application;
      use(path: string, ...handlers: RequestHandler[]): Application;
      get(path: string, ...handlers: RequestHandler[]): Application;
      /** Express's mutable app bag (the actuator seam parks here). */
      locals: Record<string, unknown>;
      listen(port: number, host: string, callback?: () => void): Server;
    }

    /** serve-static: files under root, index.html at `/`. */
    function static(root: string): RequestHandler;
  }

  export = express;
}
