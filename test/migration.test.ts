import { describe, expect, test } from "bun:test";
import { Dialect } from "json-to-sql-parser";
import { type DataModel, generateDatabaseDiff, generateInitialMigration, generateMigrationFromDiff } from "../src/index.js";

describe("Database Migration System", () => {
	const simpleModel: DataModel = {
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

	test("generateFullMigration should create proper SQL for PostgreSQL", () => {
		const result = generateInitialMigration(simpleModel, Dialect.POSTGRESQL);

		expect(result.sql).toContain('CREATE TABLE "users"');
		expect(result.sql).toContain('"id" UUID PRIMARY KEY');
		expect(result.sql).toContain('"email" TEXT NOT NULL');
		expect(result.sql).toContain("ENABLE ROW LEVEL SECURITY");
		expect(result.sql).toContain("CREATE POLICY");
	});

	test("generateFullMigration should create proper SQL for SQLite", () => {
		const result = generateInitialMigration(simpleModel, Dialect.SQLITE_MINIMAL);

		expect(result.sql).toContain('CREATE TABLE "users"');
		expect(result.sql).toContain('"id" TEXT PRIMARY KEY'); // UUID maps to TEXT in SQLite
		expect(result.sql).toContain('"email" TEXT NOT NULL');
		expect(result.sql).not.toContain("ROW LEVEL SECURITY"); // No RLS in SQLite
		expect(result.sql).not.toContain("CREATE POLICY"); // No policies in SQLite
	});

	test("generateDiff should detect table additions", () => {
		const oldModel = simpleModel;
		const newModel: DataModel = {
			...simpleModel,
			tables: [
				...simpleModel.tables,
				{
					name: "posts",
					fields: [
						{
							name: "id",
							type: "uuid",
							nonNullable: true,
							primaryKey: true,
						},
						{
							name: "title",
							type: "string",
							nonNullable: true,
						},
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

		const diff = generateDatabaseDiff(oldModel, newModel);

		expect(diff.tables.added).toHaveLength(1);
		expect(diff.tables.added[0]?.name).toBe("posts");
		expect(diff.tables.removed).toHaveLength(0);
		expect(diff.tables.modified).toHaveLength(0);
	});

	test("generateDiff should detect field additions", () => {
		const oldModel = simpleModel;
		const usersTable = simpleModel.tables[0];
		if (!usersTable) throw new Error("Users table not found");

		const newModel: DataModel = {
			...simpleModel,
			tables: [
				{
					...usersTable,
					fields: [
						...usersTable.fields,
						{
							name: "name",
							type: "string",
							nonNullable: false,
						},
					],
				},
			],
		};

		const diff = generateDatabaseDiff(oldModel, newModel);

		expect(diff.tables.added).toHaveLength(0);
		expect(diff.tables.removed).toHaveLength(0);
		expect(diff.tables.modified).toHaveLength(1);
		expect(diff.tables.modified[0]?.fieldsAdded).toHaveLength(1);
		expect(diff.tables.modified[0]?.fieldsAdded[0]?.name).toBe("name");
	});

	test("generateDiff should detect relationship additions", () => {
		const oldModel = simpleModel;
		const newModel: DataModel = {
			...simpleModel,
			relationships: [
				{
					name: "user_id",
					fromTable: "posts",
					toTable: "users",
					type: "many-to-one",
					onDelete: "cascade",
				},
			],
		};

		const diff = generateDatabaseDiff(oldModel, newModel);

		expect(diff.relationships.added).toHaveLength(1);
		expect(diff.relationships.added[0]?.name).toBe("user_id");
		expect(diff.relationships.added[0]?.onDelete).toBe("cascade");
	});

	test("generateMigrationFromDiff should create proper migration SQL", () => {
		const oldModel = simpleModel;
		const usersTable = simpleModel.tables[0];
		if (!usersTable) throw new Error("Users table not found");

		const newModel: DataModel = {
			...simpleModel,
			tables: [
				{
					...usersTable,
					fields: [
						...usersTable.fields,
						{
							name: "created_at",
							type: "datetime",
							nonNullable: true,
							default: { $func: { now: [] } },
						},
					],
				},
			],
		};

		const diff = generateDatabaseDiff(oldModel, newModel);
		const migration = generateMigrationFromDiff(diff, newModel, Dialect.POSTGRESQL);

		expect(migration.sql).toContain('ALTER TABLE "users" ADD COLUMN "created_at"');
		expect(migration.sql).toContain("TIMESTAMP WITH TIME ZONE NOT NULL");
		expect(migration.sql).toContain("DEFAULT");
	});

	test("should handle field type mapping correctly", () => {
		const modelWithVariousTypes: DataModel = {
			tables: [
				{
					name: "test_table",
					fields: [
						{ name: "id", type: "uuid", nonNullable: true, primaryKey: true },
						{ name: "text_field", type: "string", nonNullable: true },
						{ name: "num_field", type: "number", nonNullable: true },
						{ name: "bool_field", type: "boolean", nonNullable: true },
						{ name: "json_field", type: "object", nonNullable: false },
						{ name: "date_field", type: "date", nonNullable: false },
						{ name: "datetime_field", type: "datetime", nonNullable: false },
					],
					accessControl: { read: true, create: true, update: true, delete: true },
				},
			],
			relationships: [],
		};

		const postgresResult = generateInitialMigration(modelWithVariousTypes, Dialect.POSTGRESQL);
		const sqliteResult = generateInitialMigration(modelWithVariousTypes, Dialect.SQLITE_MINIMAL);

		// PostgreSQL type mapping
		expect(postgresResult.sql).toContain('"id" UUID');
		expect(postgresResult.sql).toContain('"text_field" TEXT');
		expect(postgresResult.sql).toContain('"num_field" NUMERIC');
		expect(postgresResult.sql).toContain('"bool_field" BOOLEAN');
		expect(postgresResult.sql).toContain('"json_field" JSONB');
		expect(postgresResult.sql).toContain('"date_field" DATE');
		expect(postgresResult.sql).toContain('"datetime_field" TIMESTAMP WITH TIME ZONE');

		// SQLite type mapping
		expect(sqliteResult.sql).toContain('"id" TEXT');
		expect(sqliteResult.sql).toContain('"text_field" TEXT');
		expect(sqliteResult.sql).toContain('"num_field" REAL');
		expect(sqliteResult.sql).toContain('"bool_field" INTEGER');
		expect(sqliteResult.sql).toContain('"json_field" TEXT');
		expect(sqliteResult.sql).toContain('"date_field" TEXT');
		expect(sqliteResult.sql).toContain('"datetime_field" TEXT');
	});

	test("should handle sqlite-extensions dialect correctly", () => {
		const model: DataModel = {
			tables: [
				{
					name: "json_test",
					fields: [
						{ name: "id", type: "string", nonNullable: true, primaryKey: true },
						{ name: "config", type: "object", nonNullable: true },
						{ name: "settings", type: "object", nonNullable: false },
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

		const sqliteBasic = generateInitialMigration(model, Dialect.SQLITE_MINIMAL);
		const sqliteExt = generateInitialMigration(model, Dialect.SQLITE_EXTENSIONS);

		// Basic SQLite should use TEXT for objects
		expect(sqliteBasic.sql).toContain('"config" TEXT NOT NULL');
		expect(sqliteBasic.sql).toContain('"settings" TEXT');
		expect(sqliteBasic.sql).not.toContain("JSON");

		// SQLite with extensions should use JSON type
		expect(sqliteExt.sql).toContain('"config" JSON NOT NULL');
		expect(sqliteExt.sql).toContain('"settings" JSON');
		expect(sqliteExt.sql).not.toContain('"config" TEXT');
	});
});
