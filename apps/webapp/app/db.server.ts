import { PrismaClient, Prisma } from "@trigger.dev/database";
import invariant from "tiny-invariant";
import { z } from "zod";
import { logger } from "./services/logger.server";
import { env } from "./env.server";

export type PrismaTransactionClient = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

export type PrismaClientOrTransaction = PrismaClient | PrismaTransactionClient;

function isTransactionClient(prisma: PrismaClientOrTransaction): prisma is PrismaTransactionClient {
  return !("$transaction" in prisma);
}

function isPrismaKnownError(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return (
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
  );
}

export type PrismaTransactionOptions = {
  /** The maximum amount of time (in ms) Prisma Client will wait to acquire a transaction from the database. The default value is 2000ms. */
  maxWait?: number;

  /** The maximum amount of time (in ms) the interactive transaction can run before being canceled and rolled back. The default value is 5000ms. */
  timeout?: number;

  /**  Sets the transaction isolation level. By default this is set to the value currently configured in your database. */
  isolationLevel?: Prisma.TransactionIsolationLevel;

  rethrowPrismaErrors?: boolean;
};

export async function $transaction<R>(
  prisma: PrismaClientOrTransaction,
  fn: (prisma: PrismaTransactionClient) => Promise<R>,
  options?: PrismaTransactionOptions
): Promise<R | undefined> {
  if (isTransactionClient(prisma)) {
    return fn(prisma);
  }

  try {
    return await (prisma as PrismaClient).$transaction(fn, options);
  } catch (error) {
    if (isPrismaKnownError(error)) {
      logger.debug("prisma.$transaction error", {
        code: error.code,
        meta: error.meta,
        stack: error.stack,
        message: error.message,
        name: error.name,
      });

      if (options?.rethrowPrismaErrors) {
        throw error;
      }

      return;
    }

    throw error;
  }
}

export { Prisma };

let prisma: PrismaClient;

declare global {
  var __db__: PrismaClient;
}

// this is needed because in development we don't want to restart
// the server with every change, but we want to make sure we don't
// create a new connection to the DB with every change either.
// in production we'll have a single connection to the DB.
if (process.env.NODE_ENV === "production") {
  prisma = getClient();
} else {
  if (!global.__db__) {
    global.__db__ = getClient();
  }
  prisma = global.__db__;
}

function getClient() {
  const { DATABASE_URL } = process.env;
  invariant(typeof DATABASE_URL === "string", "DATABASE_URL env var not set");

  const databaseUrl = new URL(DATABASE_URL);

  // We need to add the connection_limit and pool_timeout query params to the url, in a way that works if the DATABASE_URL already has query params
  const query = databaseUrl.searchParams;
  query.set("connection_limit", env.DATABASE_CONNECTION_LIMIT.toString());
  query.set("pool_timeout", env.DATABASE_POOL_TIMEOUT.toString());
  databaseUrl.search = query.toString();

  // Remove the username:password in the url and print that to the console
  const urlWithoutCredentials = new URL(databaseUrl.href);
  urlWithoutCredentials.password = "";

  console.log(`🔌 setting up prisma client to ${urlWithoutCredentials.toString()}`);

  const client = new PrismaClient({
    datasources: {
      db: {
        url: databaseUrl.href,
      },
    },
    log: [
      {
        emit: "stdout",
        level: "error",
      },
      {
        emit: "stdout",
        level: "info",
      },
      {
        emit: "stdout",
        level: "warn",
      },
    ],
  });

  // client.$on("query", (e) => {
  //   console.log("Query: " + e.query);
  //   console.log("Params: " + e.params);
  //   console.log("Duration: " + e.duration + "ms");
  // });

  // connect eagerly
  client.$connect();

  console.log(`🔌 prisma client connected`);

  async function findRun(prisma: PrismaClientOrTransaction, id: string) {
    return await prisma.jobRun.findUnique({
      where: { id },
      include: {
        environment: true,
        endpoint: true,
        organization: true,
        externalAccount: true,
        runConnections: {
          include: {
            integration: true,
            connection: {
              include: {
                dataReference: true,
              },
            },
          },
        },
        tasks: true,
        event: true,
        version: {
          include: {
            job: true,
            organization: true,
          },
        },
      },
    });
  }

  async function deliverEventNotification(url: string, apiKey: string, event: any) {
    const response = await fetch(`${url}/notification`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-trigger-api-key": apiKey,
        "x-trigger-action": "DELIVER_EVENT_NOTIFICATION",
      },
      body: JSON.stringify(event),
    });

    if (!response) {
      throw new Error(`Could not connect to endpoint ${url}`);
    }

    if (!response.ok) {
      throw new Error(`Could not connect to endpoint ${url}. Status code: ${response.status}`);
    }

    const anyBody = await response.json();

    logger.debug("deliverEventNotification() response from endpoint", {
      body: anyBody,
    });

    return;
  }

  return client.$extends({
    query: {
      jobRun: {
        $allOperations: async ({ model, operation, args, query }) => {
          if (([
            "update",
            "create",
            "upsert"
          ] as Array<typeof operation>).includes(operation)) {
            
            const result = await query(args);
            if (!(result && result.id)) {
              return result;
            }

            const run = await findRun(client, result.id);
            if (!run) {
              return result;
            }

            await deliverEventNotification(run.endpoint.url, run.environment.apiKey, run);
            return result;
          }

          return query(args);
        },
      },
    },
  })
}

export { prisma };
export type { PrismaClient } from "@trigger.dev/database";

export const PrismaErrorSchema = z.object({
  code: z.string(),
});
