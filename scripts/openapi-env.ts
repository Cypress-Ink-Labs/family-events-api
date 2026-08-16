// Must be imported before AppModule: ConfigModule.forRoot validates
// process.env at import time, and OpenAPI emission needs no real services.
process.env.NODE_ENV = "test"
process.env.DATABASE_URL ??= "postgresql://placeholder:placeholder@127.0.0.1:5432/placeholder"
