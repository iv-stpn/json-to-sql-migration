import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Dialect } from "json-to-sql-parser";
import { Client } from "pg";
import { type DataModel, generateDatabaseDiff, generateInitialMigration, generateMigrationFromDiff } from "../src/index.js";

describe("Database Integration Tests", () => {
	let pgClient: Client | null = null;
	let pgAvailable = false;
	const testDbPath = join(import.meta.dir, "test-db.sqlite");

	beforeAll(async () => {
		// Try to setup PostgreSQL connection (only if available)
		try {
			pgClient = new Client({
				host: "localhost",
				port: 5432,
				database: "json_sql_parser_test",
				user: "testuser",
				password: "testpass",
			});

			await pgClient.connect();
			pgAvailable = true;
			console.log("✅ Connected to PostgreSQL");
		} catch (_error) {
			console.warn("⚠️  PostgreSQL not available, skipping PostgreSQL tests");
			pgAvailable = false;
			pgClient = null;
		}

		// Clean up any existing test databases
		try {
			if (existsSync(testDbPath)) unlinkSync(testDbPath);
		} catch {
			// Ignore cleanup errors
		}
	});

	afterAll(async () => {
		if (pgClient) {
			try {
				await pgClient.end();
			} catch {
				// Ignore cleanup errors
			}
		}

		// Clean up test databases
		try {
			if (existsSync(testDbPath)) unlinkSync(testDbPath);
		} catch {
			// Ignore cleanup errors
		}
	});

	const sampleModel: DataModel = {
		tables: [
			{
				name: "users",
				fields: [
					{ name: "id", type: "uuid", nonNullable: true, primaryKey: true },
					{ name: "email", type: "string", nonNullable: true },
					{ name: "name", type: "string", nonNullable: false },
					{ name: "age", type: "number", nonNullable: false },
					{ name: "is_active", type: "boolean", nonNullable: true, default: true },
					{ name: "metadata", type: "object", nonNullable: false },
					{ name: "created_at", type: "datetime", nonNullable: true, default: { $func: { NOW: [] } } },
				],
				accessControl: {
					read: { id: { $eq: { $var: "user_id" } } },
					create: true,
					update: { id: { $eq: { $var: "user_id" } } },
					delete: false,
				},
			},
			{
				name: "posts",
				fields: [
					{ name: "id", type: "uuid", nonNullable: true, primaryKey: true },
					{ name: "title", type: "string", nonNullable: true },
					{ name: "content", type: "string", nonNullable: false },
					{ name: "author_id", type: "uuid", nonNullable: true },
					{ name: "published", type: "boolean", nonNullable: true, default: false },
					{ name: "view_count", type: "number", nonNullable: true, default: 0 },
					{ name: "tags", type: "object", nonNullable: false },
					{ name: "created_at", type: "datetime", nonNullable: true, default: { $func: { NOW: [] } } },
				],
				accessControl: {
					read: {
						$or: [{ published: { $eq: true } }, { author_id: { $eq: { $var: "user_id" } } }],
					},
					create: { author_id: { $eq: { $var: "user_id" } } },
					update: { author_id: { $eq: { $var: "user_id" } } },
					delete: { author_id: { $eq: { $var: "user_id" } } },
				},
			},
		],
		relationships: [
			{
				name: "author_id",
				fromTable: "posts",
				toTable: "users",
				type: "many-to-one",
				onDelete: "cascade",
			},
		],
	};

	describe("PostgreSQL Integration", () => {
		test("should execute full migration SQL successfully", async () => {
			if (!pgAvailable || !pgClient) {
				console.warn("Skipping PostgreSQL test - database not available");
				return;
			}

			const migration = generateInitialMigration(sampleModel, Dialect.POSTGRESQL);

			// Clean up any existing tables first
			await pgClient.query(`
				DROP TABLE IF EXISTS posts CASCADE;
				DROP TABLE IF EXISTS users CASCADE;
			`);

			// Execute the generated SQL
			const statements = migration.sql.split(";").filter((s) => s.trim());

			for (const statement of statements) {
				if (statement.trim()) {
					try {
						await pgClient.query(statement.trim());
					} catch (error) {
						console.error(`Failed to execute statement: ${statement.trim()}`);
						throw error;
					}
				}
			}

			// Verify tables were created
			const tablesResult = await pgClient.query(`
				SELECT table_name FROM information_schema.tables 
				WHERE table_schema = 'migration_test' 
				ORDER BY table_name;
			`);

			const tableNames = tablesResult.rows.map((row) => row.table_name);
			expect(tableNames).toContain("users");
			expect(tableNames).toContain("posts");

			// Test inserting data
			await pgClient.query(`
				INSERT INTO migration_test.users (id, email, name, age) 
				VALUES ('550e8400-e29b-41d4-a716-446655440000', 'test@example.com', 'Test User', 30);
			`);

			await pgClient.query(`
				INSERT INTO migration_test.posts (id, title, content, author_id) 
				VALUES ('550e8400-e29b-41d4-a716-446655440001', 'Test Post', 'Test Content', '550e8400-e29b-41d4-a716-446655440000');
			`);

			// Verify data was inserted
			const postsResult = await pgClient.query("SELECT COUNT(*) FROM migration_test.posts");
			expect(Number(postsResult.rows[0].count)).toBe(1);
		});

		test("should execute diff-based migration SQL successfully", async () => {
			if (!pgAvailable || !pgClient) {
				console.warn("Skipping PostgreSQL test - database not available");
				return;
			}

			// Clean up any existing comments table first
			await pgClient.query(`
				DROP TABLE IF EXISTS comments CASCADE;
			`);

			// Add a new table to the model
			const updatedModel: DataModel = {
				...sampleModel,
				tables: [
					...sampleModel.tables,
					{
						name: "comments",
						fields: [
							{ name: "id", type: "uuid", nonNullable: true, primaryKey: true },
							{ name: "content", type: "string", nonNullable: true },
							{ name: "author_id", type: "uuid", nonNullable: true },
							{ name: "post_id", type: "uuid", nonNullable: true },
							{ name: "created_at", type: "datetime", nonNullable: true, default: { $func: { NOW: [] } } },
						],
						accessControl: {
							read: true,
							create: { author_id: { $eq: { $var: "user_id" } } },
							update: { author_id: { $eq: { $var: "user_id" } } },
							delete: { author_id: { $eq: { $var: "user_id" } } },
						},
					},
				],
				relationships: [
					...sampleModel.relationships,
					{
						name: "author_id",
						fromTable: "comments",
						toTable: "users",
						type: "many-to-one",
						onDelete: "cascade",
					},
					{
						name: "post_id",
						fromTable: "comments",
						toTable: "posts",
						type: "many-to-one",
						onDelete: "cascade",
					},
				],
			};

			const diff = generateDatabaseDiff(sampleModel, updatedModel);
			const migration = generateMigrationFromDiff(diff, updatedModel, Dialect.POSTGRESQL);

			// Execute the migration
			const statements = migration.sql.split(";").filter((s) => s.trim());

			for (const statement of statements) {
				if (statement.trim()) {
					await pgClient.query(statement.trim());
				}
			}

			// Verify the new table was created
			const tablesResult = await pgClient.query(`
				SELECT table_name FROM information_schema.tables 
				WHERE table_schema = 'migration_test' AND table_name = 'comments';
			`);

			expect(tablesResult.rows.length).toBe(1);
		});
	});

	describe("SQLite Integration", () => {
		test("should execute full migration SQL successfully", () => {
			const db = new Database(testDbPath);

			try {
				const migration = generateInitialMigration(sampleModel, Dialect.SQLITE_MINIMAL);

				// Execute the generated SQL
				const statements = migration.sql.split(";").filter((s) => {
					const trimmed = s.trim();
					return trimmed && !trimmed.startsWith("--");
				});

				for (const statement of statements) {
					if (statement.trim()) {
						db.exec(statement.trim());
					}
				}

				// Verify tables were created
				const tables = db
					.prepare(`
					SELECT name FROM sqlite_master 
					WHERE type='table' AND name NOT LIKE 'sqlite_%' 
					ORDER BY name;
				`)
					.all();

				const tableNames = (tables as Array<{ name: string }>).map((t) => t.name);
				expect(tableNames).toContain("users");
				expect(tableNames).toContain("posts");

				// Test inserting data
				db.prepare(`
					INSERT INTO users (id, email, name, age) 
					VALUES (?, ?, ?, ?)
				`).run("test-uuid-1", "test@example.com", "Test User", 30);

				db.prepare(`
					INSERT INTO posts (id, title, content, author_id) 
					VALUES (?, ?, ?, ?)
				`).run("test-uuid-2", "Test Post", "Test Content", "test-uuid-1");

				// Verify data was inserted
				const usersCount = db.prepare("SELECT COUNT(*) as count FROM users").get() as { count: number };
				const postsCount = db.prepare("SELECT COUNT(*) as count FROM posts").get() as { count: number };

				expect(usersCount.count).toBe(1);
				expect(postsCount.count).toBe(1);
			} finally {
				db.close();
			}
		});

		test("should handle diff-based migration for SQLite", () => {
			const db = new Database(testDbPath);

			try {
				// Start with basic model and add a table
				const updatedModel: DataModel = {
					...sampleModel,
					tables: [
						...sampleModel.tables.map((table) => {
							if (table.name === "users") {
								return {
									...table,
									fields: [...table.fields, { name: "phone", type: "string" as const, nonNullable: false }],
								};
							}
							return table;
						}),
						{
							name: "categories",
							fields: [
								{ name: "id", type: "string" as const, nonNullable: true, primaryKey: true },
								{ name: "name", type: "string" as const, nonNullable: true },
								{ name: "description", type: "string" as const, nonNullable: false },
							],
							accessControl: {
								read: true,
								create: true,
								update: true,
								delete: true,
							},
						},
					],
				};

				const diff = generateDatabaseDiff(sampleModel, updatedModel);
				const migration = generateMigrationFromDiff(diff, updatedModel, Dialect.SQLITE_MINIMAL);

				// Execute the migration
				const statements = migration.sql.split(";").filter((s) => s.trim());

				for (const statement of statements) {
					if (statement.trim()) {
						db.exec(statement.trim());
					}
				}

				// Verify the new table was created
				const tables = db
					.prepare(`
					SELECT name FROM sqlite_master 
					WHERE type='table' AND name = 'categories';
				`)
					.all();

				expect(tables.length).toBe(1);

				// Test inserting data into new structures
				db.prepare(`
					INSERT INTO categories (id, name, description) 
					VALUES (?, ?, ?)
				`).run("cat-1", "Technology", "Tech-related posts");

				const categoriesCount = db.prepare("SELECT COUNT(*) as count FROM categories").get() as { count: number };
				expect(categoriesCount.count).toBe(1);
			} finally {
				db.close();
			}
		});
	});

	describe("Cross-Database Compatibility", () => {
		test("should generate different SQL for different dialects", () => {
			const pgMigration = generateInitialMigration(sampleModel, Dialect.POSTGRESQL);
			const sqliteMigration = generateInitialMigration(sampleModel, Dialect.SQLITE_MINIMAL);
			const sqliteExtMigration = generateInitialMigration(sampleModel, Dialect.SQLITE_EXTENSIONS);

			// PostgreSQL should have UUID types and JSONB
			expect(pgMigration.sql).toContain("UUID");
			expect(pgMigration.sql).toContain("JSONB");
			expect(pgMigration.sql).toContain("TIMESTAMP WITH TIME ZONE");
			expect(pgMigration.sql).toContain("ROW LEVEL SECURITY");

			// SQLite minimal should use TEXT for everything
			expect(sqliteMigration.sql).toContain("TEXT");
			expect(sqliteMigration.sql).not.toContain("UUID");
			expect(sqliteMigration.sql).not.toContain("JSONB");
			expect(sqliteMigration.sql).not.toContain("ROW LEVEL SECURITY");

			// SQLite with extensions should use JSON type
			expect(sqliteExtMigration.sql).toContain("JSON");
			expect(sqliteExtMigration.sql).not.toContain("JSONB");

			// All should be different
			expect(pgMigration.sql).not.toBe(sqliteMigration.sql);
			expect(sqliteMigration.sql).not.toBe(sqliteExtMigration.sql);
		});

		test("should handle RLS conditions correctly in PostgreSQL", () => {
			const complexModel: DataModel = {
				tables: [
					{
						name: "complex_table",
						fields: [
							{ name: "id", type: "uuid", nonNullable: true, primaryKey: true },
							{ name: "status", type: "string", nonNullable: true },
							{ name: "priority", type: "string", nonNullable: true },
							{ name: "data", type: "object", nonNullable: false },
						],
						accessControl: {
							read: {
								$and: [
									{ status: { $eq: "active" } },
									{ priority: { $eq: "high" } },
									{ $or: [{ data: { $ne: null } }, { priority: { $eq: "urgent" } }] },
								],
							},
							create: true,
							update: { status: { $eq: "draft" } },
							delete: false,
						},
					},
				],
				relationships: [],
			};

			const pgMigration = generateInitialMigration(complexModel, Dialect.POSTGRESQL);
			const sqliteMigration = generateInitialMigration(complexModel, Dialect.SQLITE_MINIMAL);

			// PostgreSQL should have proper RLS policies with complex conditions
			expect(pgMigration.sql).toContain("CREATE POLICY");
			expect(pgMigration.sql).toContain("complex_table_read_policy");
			expect(pgMigration.sql).toContain("AND");
			expect(pgMigration.sql).toContain("OR");

			// SQLite doesn't support RLS
			expect(sqliteMigration.sql).not.toContain("ROW LEVEL SECURITY");
			expect(sqliteMigration.sql).not.toContain("CREATE POLICY");
		});
	});

	describe("SQLite Extensions Dialect (SQL Generation Only)", () => {
		test("should generate proper JSON types for sqlite-extensions", () => {
			const jsonModel: DataModel = {
				tables: [
					{
						name: "json_table",
						fields: [
							{ name: "id", type: "string", nonNullable: true, primaryKey: true },
							{ name: "config", type: "object", nonNullable: true },
							{ name: "settings", type: "object", nonNullable: false },
							{ name: "score", type: "number", nonNullable: true, default: 0 },
						],
						accessControl: {
							read: true,
							create: true,
							update: true,
							delete: true,
						},
					},
				],
				relationships: [],
			};

			const sqliteBasic = generateInitialMigration(jsonModel, Dialect.SQLITE_MINIMAL);
			const sqliteExt = generateInitialMigration(jsonModel, Dialect.SQLITE_EXTENSIONS);

			// Basic SQLite should use TEXT for objects
			expect(sqliteBasic.sql).toContain('"config" TEXT NOT NULL');
			expect(sqliteBasic.sql).toContain('"settings" TEXT');
			expect(sqliteBasic.sql).not.toContain("JSON");

			// SQLite with extensions should use JSON type
			expect(sqliteExt.sql).toContain('"config" JSON NOT NULL');
			expect(sqliteExt.sql).toContain('"settings" JSON');

			// Both should have the same other types
			expect(sqliteBasic.sql).toContain('"score" REAL');
			expect(sqliteExt.sql).toContain('"score" REAL');
		});

		test("should demonstrate extension-only SQL features", () => {
			// This test shows what SQLite Extensions SQL would look like
			// but cannot be executed with Bun's SQLite

			const extModel: DataModel = {
				tables: [
					{
						name: "math_table",
						fields: [
							{ name: "id", type: "string", nonNullable: true, primaryKey: true },
							{ name: "data", type: "object", nonNullable: true },
							{ name: "calculated_field", type: "number", nonNullable: false },
						],
						accessControl: {
							read: true,
							create: true,
							update: true,
							delete: true,
						},
					},
				],
				relationships: [],
			};

			const extMigration = generateInitialMigration(extModel, Dialect.SQLITE_EXTENSIONS);

			// Should generate JSON type (which requires extensions)
			expect(extMigration.sql).toContain('"data" JSON NOT NULL');

			// Note: In a real SQLite with extensions, you could use mathematical functions like:
			// - sqrt(), sin(), cos(), log10(), power()
			// - JSON functions: json_extract(), json_set(), etc.
			// - Full-text search: FTS5
			// But these cannot be tested with Bun's built-in SQLite

			console.log("🔧 SQLite Extensions dialect generates SQL for:");
			console.log("   • JSON data types");
			console.log("   • Mathematical functions (sqrt, sin, cos, etc.)");
			console.log("   • Advanced JSON operations");
			console.log("   • Full-text search capabilities");
			console.log("   Note: These features require a SQLite build with extensions");
		});
	});
});
