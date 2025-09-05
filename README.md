# JSON to SQL Migration Generator

A TypeScript library that converts JSON-based data schemas into SQL migrations
with support for PostgreSQL and SQLite. This library provides a type-safe way to
generate database migrations from declarative JSON schemas, including support
for Row Level Security (RLS) policies in PostgreSQL.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)

## Features

- 🔄 **Schema Diffing**: Compare two data models and generate incremental
  migrations
- 🗄️ **Multi-Database Support**: PostgreSQL, SQLite (with and without
  extensions)
- 🔒 **Access Control**: Built-in Row Level Security (RLS) support for
  PostgreSQL
- 📊 **Relationships**: Foreign key constraints with cascade options
- 🎯 **Type Safety**: Full TypeScript support with Zod schema validation
- ⚡ **Fast**: Built with Bun runtime for optimal performance
- 🧪 **Well Tested**: Comprehensive test suite with integration tests

## Installation

```bash
npm install json-to-sql-migration
# or
pnpm add json-to-sql-migration
# or
bun add json-to-sql-migration
```

## Quick Start

```typescript
import {
  type DataModel,
  generateDatabaseDiff,
  generateInitialMigration,
  generateMigrationFromDiff,
} from "json-to-sql-migration";
import { Dialect } from "json-to-sql-parser";

// Define your data model
const dataModel: DataModel = {
  tables: [
    {
      name: "users",
      fields: [
        {
          name: "id",
          type: "uuid",
          nonNullable: true,
          primaryKey: true,
        },
        {
          name: "email",
          type: "string",
          nonNullable: true,
        },
        {
          name: "created_at",
          type: "datetime",
          nonNullable: true,
          default: { $func: { now: [] } },
        },
      ],
      accessControl: {
        read: true,
        create: true,
        update: { $eq: [{ $field: "id" }, { $var: "user_id" }] },
        delete: false,
      },
    },
  ],
};

// Generate initial migration
const migration = generateInitialMigration(dataModel, Dialect.POSTGRESQL);
console.log(migration.sql);
```

## Schema Definition

### Data Model Structure

```typescript
type DataModel = {
  tables: Array<{
    name: string;
    fields: Array<{
      name: string;
      type:
        | "string"
        | "number"
        | "boolean"
        | "object"
        | "date"
        | "datetime"
        | "uuid";
      nonNullable?: boolean;
      primaryKey?: boolean;
      default?: any; // JSON expression
      foreignKey?: {
        table: string;
        field: string;
        onDelete?: "cascade" | "restrict" | "set_null";
        onUpdate?: "cascade" | "restrict" | "set_null";
      };
    }>;
    accessControl: {
      read: Condition;
      create: Condition;
      update: Condition;
      delete: Condition;
    };
  }>;
};
```

### Access Control Conditions

Access control conditions support complex expressions:

```typescript
// Simple boolean
const condition1 = true;

// Field comparison
const condition2 = {
  $eq: [{ $field: "user_id" }, { $var: "current_user_id" }],
};

// Complex conditions
const condition3 = {
  $and: [
    { $eq: [{ $field: "status" }, "active"] },
    {
      $or: [
        { $eq: [{ $field: "owner_id" }, { $var: "user_id" }] },
        { $eq: [{ $field: "public" }, true] },
      ],
    },
  ],
};
```

## API Reference

### Core Functions

#### `generateInitialMigration(model, dialect)`

Generates a complete SQL migration from a data model.

```typescript
const migration = generateInitialMigration(dataModel, Dialect.POSTGRESQL);
// Returns: { sql: string, accessControlDiff: AccessControlDiff }
```

#### `generateDatabaseDiff(oldModel, newModel)`

Compares two data models and returns a diff object.

```typescript
const diff = generateDatabaseDiff(oldModel, newModel);
// Returns: DatabaseDiff
```

#### `generateMigrationFromDiff(diff, targetModel, dialect)`

Generates SQL migration from a database diff.

```typescript
const migration = generateMigrationFromDiff(diff, newModel, Dialect.POSTGRESQL);
// Returns: { sql: string, accessControlDiff: AccessControlDiff }
```

### Supported Dialects

- `Dialect.POSTGRESQL` - Full PostgreSQL support with RLS
- `Dialect.SQLITE_MINIMAL` - Basic SQLite support
- `Dialect.SQLITE_EXTENSIONS` - SQLite with JSON extensions

### Field Types

| Type       | PostgreSQL                 | SQLite    | SQLite Extended |
| ---------- | -------------------------- | --------- | --------------- |
| `string`   | `TEXT`                     | `TEXT`    | `TEXT`          |
| `number`   | `NUMERIC`                  | `REAL`    | `REAL`          |
| `boolean`  | `BOOLEAN`                  | `INTEGER` | `INTEGER`       |
| `object`   | `JSONB`                    | `TEXT`    | `JSON`          |
| `date`     | `DATE`                     | `TEXT`    | `TEXT`          |
| `datetime` | `TIMESTAMP WITH TIME ZONE` | `TEXT`    | `TEXT`          |
| `uuid`     | `UUID`                     | `TEXT`    | `TEXT`          |

## Examples

### Creating Tables with Relationships

```typescript
const blogModel: DataModel = {
  tables: [
    {
      name: "users",
      fields: [
        { name: "id", type: "uuid", nonNullable: true, primaryKey: true },
        { name: "email", type: "string", nonNullable: true },
        { name: "name", type: "string", nonNullable: false },
      ],
      accessControl: {
        read: true,
        create: true,
        update: { $eq: [{ $field: "id" }, { $var: "user_id" }] },
        delete: false,
      },
    },
    {
      name: "posts",
      fields: [
        { name: "id", type: "uuid", nonNullable: true, primaryKey: true },
        { name: "title", type: "string", nonNullable: true },
        { name: "content", type: "string", nonNullable: true },
        {
          name: "author_id",
          type: "uuid",
          nonNullable: true,
          foreignKey: {
            table: "users",
            field: "id",
            onDelete: "cascade",
          },
        },
        { name: "published_at", type: "datetime", nonNullable: false },
      ],
      accessControl: {
        read: { $eq: [{ $field: "published_at" }, null] }, // Only published posts
        create: { $eq: [{ $field: "author_id" }, { $var: "user_id" }] },
        update: { $eq: [{ $field: "author_id" }, { $var: "user_id" }] },
        delete: { $eq: [{ $field: "author_id" }, { $var: "user_id" }] },
      },
    },
  ],
};

const migration = generateInitialMigration(blogModel, Dialect.POSTGRESQL);
```

### Incremental Migrations

```typescript
// Initial model
const v1Model: DataModel = {
  tables: [
    {
      name: "users",
      fields: [
        { name: "id", type: "uuid", nonNullable: true, primaryKey: true },
        { name: "email", type: "string", nonNullable: true },
      ],
      accessControl: { read: true, create: true, update: true, delete: true },
    },
  ],
};

// Updated model with new field
const v2Model: DataModel = {
  tables: [
    {
      name: "users",
      fields: [
        { name: "id", type: "uuid", nonNullable: true, primaryKey: true },
        { name: "email", type: "string", nonNullable: true },
        {
          name: "created_at",
          type: "datetime",
          nonNullable: true,
          default: { $func: { now: [] } },
        },
      ],
      accessControl: { read: true, create: true, update: true, delete: true },
    },
  ],
};

// Generate incremental migration
const diff = generateDatabaseDiff(v1Model, v2Model);
const migration = generateMigrationFromDiff(diff, v2Model, Dialect.POSTGRESQL);
```

## Development

### Prerequisites

- [Bun](https://bun.sh/) (recommended) or Node.js 18+
- Docker (for integration tests)

### Setup

```bash
# Clone the repository
git clone https://github.com/iv-stpn/json-to-sql-migration.git
cd json-to-sql-migration

# Install dependencies
bun install

# Start PostgreSQL for testing
docker-compose up -d

# Run tests
bun test

# Build the library
bun run build
```

### Scripts

- `bun run build` - Build the library
- `bun run test` - Run unit tests
- `bun run test:integration` - Run integration tests with PostgreSQL
- `bun run test:all` - Run all tests
- `bun run lint` - Lint code with Biome
- `bun run format` - Format code with Biome
- `bun run typecheck` - Type check with TypeScript

## Contributing

Contributions are welcome! Please read the
[contributing guidelines](https://github.com/iv-stpn/json-to-sql-migration/blob/main/CONTRIBUTING.md)
and follow the code of conduct.

### Project Structure

```
├── src/
│   ├── index.ts          # Main library exports
│   └── schemas.ts        # Zod schemas for validation
├── test/
│   ├── migration.test.ts # Unit tests
│   ├── integration.test.ts # Integration tests
│   └── _init.sql        # Test database initialization
├── scripts/
│   └── check-postgres.ts # PostgreSQL health check
└── docker-compose.yml   # PostgreSQL test environment
```

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file
for details.

## Dependencies

- [json-to-sql-parser](https://github.com/iv-stpn/json-to-sql-parser) - SQL
  expression parsing
- [zod](https://github.com/colinhacks/zod) - TypeScript schema validation

## Related Projects

- [json-to-sql-parser](https://github.com/iv-stpn/json-to-sql-parser) - The
  underlying SQL parser used by this library

---

Made with ❤️ by [Ivan Stepanian](https://github.com/iv-stpn)
