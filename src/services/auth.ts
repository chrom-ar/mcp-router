import { Request, Response, NextFunction } from "express";

interface ValidationResponse {
  valid: boolean;
  userId?: string;
  email?: string;
  error?: string;
}

interface AuthConfig {
  enabled: boolean;
  userManagementApi: string;
  skipPaths?: string[];
}

const headers = {
  "Content-Type": "application/json",
};

export const getAuthConfig = (): AuthConfig => {
  return {
    enabled: process.env.AUTH_ENABLED === "true",
    userManagementApi: process.env.USER_MANAGEMENT_API || "https://users.chrom.ar",
    skipPaths: process.env.AUTH_SKIP_PATHS?.split(",") || ["/health", "/register", "/unregister"],
  };
};

export const validateApiKey = async (
  apiKey: string,
  userManagementApi: string,
): Promise<ValidationResponse> => {
  try {
    const response = await fetch(`${userManagementApi}/validate`, {
      method: "POST",
      headers,
      body: JSON.stringify({ apiKey }),
    });

    if (!response.ok) {
      return { valid: false };
    }

    return (await response.json()) as ValidationResponse;
  } catch (error: unknown) {
    console.error("Error validating API key:", error);

    return { valid: false };
  }
};

export const authMiddleware = (authConfig: AuthConfig) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!authConfig.enabled) {
      return next();
    }

    const path = req.path;

    if (authConfig.skipPaths?.some(skipPath => path.startsWith(skipPath))) {
      return next();
    }

    const authHeader = req.headers.authorization || req.headers.Authorization;

    if (!authHeader || typeof authHeader !== "string") {
      res.status(401).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Authorization required",
        },
        id: null,
      });

      return;
    }

    if (!authHeader.startsWith("Bearer ")) {
      res.status(401).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Invalid authorization format. Use Bearer token",
        },
        id: null,
      });

      return;
    }

    const apiKey = authHeader.replace(/^Bearer\s+/i, "").trim();

    if (!apiKey) {
      res.status(401).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "API key required",
        },
        id: null,
      });

      return;
    }

    const validation = await validateApiKey(apiKey, authConfig.userManagementApi);

    if (!validation.valid) {
      res.status(401).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Invalid API key",
        },
        id: null,
      });

      return;
    }

    interface RequestWithUser extends Request {
      user?: {
        userId?: string;
        email?: string;
        apiKey?: string;
      };
    }

    (req as RequestWithUser).user = {
      userId: validation.userId,
      email: validation.email,
      apiKey,
    };

    next();
  };
};

export const getUserFromRequest = (req: Request): { userId?: string; email?: string; apiKey?: string } | undefined => {
  interface RequestWithUser extends Request {
    user?: {
      userId?: string;
      email?: string;
      apiKey?: string;
    };
  }

  return (req as RequestWithUser).user;
};
