import { z } from 'zod';

const optionalText = z.string().trim().min(1).optional();

const EnvSchema = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  SAML_ENABLED: z.stringbool().default(false),
  SAML_ENTRY_POINT: optionalText,
  SAML_ISSUER: optionalText,
  SAML_IDP_CERT: optionalText,
  SAML_CALLBACK_URL: optionalText,
});

function requiredWithSaml(name: string) {
  return { error: `${name} is required when SAML_ENABLED=true` };
}

const SamlConfigSchema = z.discriminatedUnion('enabled', [
  z.object({ enabled: z.literal(false) }),
  z.object({
    enabled: z.literal(true),
    issuer: z.string(requiredWithSaml('SAML_ISSUER')),
    entryPoint: z.url(requiredWithSaml('SAML_ENTRY_POINT (a URL)')),
    idpCert: z.string(requiredWithSaml('SAML_IDP_CERT')),
    callbackUrl: z.url(requiredWithSaml('SAML_CALLBACK_URL (a URL)')),
  }),
]);
export type SamlConfig = z.infer<typeof SamlConfigSchema>;

const ConfigSchema = EnvSchema.transform((env) => ({
  databaseUrl: env.DATABASE_URL,
  jwtSecret: env.JWT_SECRET,
  jwtTtlSeconds: env.JWT_TTL_SECONDS,
  corsOrigins: env.CORS_ORIGIN.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  port: env.PORT,
  logLevel: env.LOG_LEVEL,
  saml: env.SAML_ENABLED
    ? {
        enabled: true,
        issuer: env.SAML_ISSUER,
        entryPoint: env.SAML_ENTRY_POINT,
        idpCert: env.SAML_IDP_CERT,
        callbackUrl: env.SAML_CALLBACK_URL,
      }
    : { enabled: false },
})).pipe(
  z.object({
    databaseUrl: z.string(),
    jwtSecret: z.string(),
    jwtTtlSeconds: z.number(),
    corsOrigins: z.array(z.string()),
    port: z.number(),
    logLevel: EnvSchema.shape.LOG_LEVEL.unwrap(),
    saml: SamlConfigSchema,
  }),
);
export type Config = z.infer<typeof ConfigSchema>;

/** Parses the environment once at startup and throws, naming every bad variable, if it is invalid. */
export function loadConfig(rawEnv: Record<string, string | undefined>): Config {
  // A copied .env.example leaves blank values: blank means unset, so defaults apply.
  const env = Object.fromEntries(Object.entries(rawEnv).filter(([, value]) => value !== ''));
  const result = ConfigSchema.safeParse(env);
  if (result.success) return result.data;
  const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
  throw new Error(`Invalid configuration: ${issues.join('; ')}`);
}
