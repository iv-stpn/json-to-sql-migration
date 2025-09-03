import type { AnyExpression, Condition, Config, fieldTypes, ParserState } from "json-to-sql-parser";
import { Dialect, ExpressionTypeMap, parseCondition, parseExpression } from "json-to-sql-parser";
//
import type { z } from "zod";
import type { dataModelSchema } from "./schemas";

export type DataModel = z.infer<typeof dataModelSchema>;

type FieldChange = {
	type?: { from: string; to: string };
	nonNullable?: { from: boolean; to: boolean };
	primaryKey?: { from: boolean; to: boolean };
	default?: { from: AnyExpression | undefined; to: AnyExpression | undefined };
	foreignKey?: {
		from: Field["foreignKey"] | undefined;
		to: Field["foreignKey"] | undefined;
	};
};

type Field = DataModel["tables"][number]["fields"][number];

type TableModification = {
	tableName: string;
	fieldsAdded: Field[];
	fieldsRemoved: Field[];
	fieldsModified: Array<{
		field: Field;
		changes: FieldChange;
	}>;
	accessControlChanged: boolean;
};

type AccessControlChange = {
	read?: { from: Condition; to: Condition };
	create?: { from: Condition; to: Condition };
	update?: { from: Condition; to: Condition };
	delete?: { from: Condition; to: Condition };
};

export type TableDiff = {
	added: DataModel["tables"];
	removed: DataModel["tables"];
	modified: TableModification[];
};

export type AccessControlDiff = {
	tables: Array<{ tableName: string; changes: AccessControlChange }>;
};

export type DatabaseDiff = { tables: TableDiff; accessControl: AccessControlDiff };
export type MigrationResult = { sql: string; accessControlDiff: AccessControlDiff };

/**
 * Compare two data models and generate a diff
 */
export function generateDatabaseDiff(oldModel: DataModel, newModel: DataModel): DatabaseDiff {
	const tableDiff = generateTableDiff(oldModel.tables, newModel.tables);
	const accessControlDiff = generateAccessControlDiff(oldModel.tables, newModel.tables);

	return { tables: tableDiff, accessControl: accessControlDiff };
}

/**
 * Generate SQL migration from a database diff
 */
export function generateMigrationFromDiff(diff: DatabaseDiff, targetModel: DataModel, dialect: Dialect): MigrationResult {
	const sqlParts: string[] = [];

	// Handle table removals first
	for (const table of diff.tables.removed) {
		sqlParts.push(`DROP TABLE IF EXISTS "${table.name}";`);
	}

	// Handle table additions
	for (const table of diff.tables.added) {
		sqlParts.push(generateCreateTableSQL(table, dialect));
	}

	// Handle table modifications
	for (const modification of diff.tables.modified) {
		// Add new fields
		for (const field of modification.fieldsAdded) {
			sqlParts.push(generateAddColumnSQL(modification.tableName, field, dialect));

			// If the new field has a foreign key, add it separately for PostgreSQL
			if (field.foreignKey && dialect === Dialect.POSTGRESQL) {
				const constraintName = `fk_${modification.tableName}_${field.name}`;
				let sql = `ALTER TABLE "${modification.tableName}" ADD CONSTRAINT "${constraintName}" FOREIGN KEY ("${field.name}") REFERENCES "${field.foreignKey.table}" ("${field.foreignKey.field}")`;

				if (field.foreignKey.onDelete) sql += ` ON DELETE ${field.foreignKey.onDelete.toUpperCase().replace(" ", " ")}`;
				if (field.foreignKey.onUpdate) sql += ` ON UPDATE ${field.foreignKey.onUpdate.toUpperCase().replace(" ", " ")}`;
				sqlParts.push(`${sql};`);
			}
		}

		// Remove fields
		for (const field of modification.fieldsRemoved) {
			// For PostgreSQL, drop foreign key constraint first if it exists
			if (field.foreignKey && dialect === Dialect.POSTGRESQL) {
				const constraintName = `fk_${modification.tableName}_${field.name}`;
				sqlParts.push(`ALTER TABLE "${modification.tableName}" DROP CONSTRAINT IF EXISTS "${constraintName}";`);
			}
			sqlParts.push(`ALTER TABLE "${modification.tableName}" DROP COLUMN "${field.name}";`);
		}

		// Modify existing fields
		for (const fieldMod of modification.fieldsModified) {
			// Handle foreign key changes
			if (fieldMod.changes.foreignKey && dialect === Dialect.POSTGRESQL) {
				const constraintName = `fk_${modification.tableName}_${fieldMod.field.name}`;

				// Drop old constraint if it existed
				if (fieldMod.changes.foreignKey.from) {
					sqlParts.push(`ALTER TABLE "${modification.tableName}" DROP CONSTRAINT IF EXISTS "${constraintName}";`);
				}

				// Add new constraint if it exists
				if (fieldMod.changes.foreignKey.to) {
					const fk = fieldMod.changes.foreignKey.to;
					let sql = `ALTER TABLE "${modification.tableName}" ADD CONSTRAINT "${constraintName}" FOREIGN KEY ("${fieldMod.field.name}") REFERENCES "${fk.table}" ("${fk.field}")`;

					if (fk.onDelete) sql += ` ON DELETE ${fk.onDelete.toUpperCase().replace(" ", " ")}`;
					if (fk.onUpdate) sql += ` ON UPDATE ${fk.onUpdate.toUpperCase().replace(" ", " ")}`;
					sqlParts.push(`${sql};`);
				}
			}

			sqlParts.push(generateAlterColumnSQL(modification.tableName, fieldMod.field, fieldMod.changes, dialect));
		}
	}

	// Handle RLS policies for PostgreSQL
	if (dialect === Dialect.POSTGRESQL) sqlParts.push(...generateRLSPoliciesSQL(diff.accessControl, targetModel));

	return { sql: sqlParts.filter(Boolean).join("\n\n"), accessControlDiff: diff.accessControl };
}

/**
 * Generate a complete migration from a single data model (create everything from scratch)
 */
export function generateInitialMigration(model: DataModel, dialect: Dialect): MigrationResult {
	const sqlParts: string[] = [];

	// Create all tables
	for (const table of model.tables) sqlParts.push(generateCreateTableSQL(table, dialect));

	// Create foreign key constraints for PostgreSQL (SQLite handles them inline)
	if (dialect === Dialect.POSTGRESQL) {
		for (const table of model.tables) {
			for (const field of table.fields) {
				if (field.foreignKey) {
					const constraintName = `fk_${table.name}_${field.name}`;
					let sql = `ALTER TABLE "${table.name}" ADD CONSTRAINT "${constraintName}" FOREIGN KEY ("${field.name}") REFERENCES "${field.foreignKey.table}" ("${field.foreignKey.field}")`;

					if (field.foreignKey.onDelete) sql += ` ON DELETE ${field.foreignKey.onDelete.toUpperCase().replace(" ", " ")}`;
					if (field.foreignKey.onUpdate) sql += ` ON UPDATE ${field.foreignKey.onUpdate.toUpperCase().replace(" ", " ")}`;
					sqlParts.push(`${sql};`);
				}
			}
		}
	}

	// Generate RLS policies for PostgreSQL
	if (dialect === Dialect.POSTGRESQL) {
		const accessControlDiff = generateAccessControlDiffForFullMigration(model.tables);
		sqlParts.push(...generateRLSPoliciesSQL(accessControlDiff, model));

		return { sql: sqlParts.filter(Boolean).join("\n\n"), accessControlDiff };
	}

	return { sql: sqlParts.filter(Boolean).join("\n\n"), accessControlDiff: { tables: [] } };
}

// Helper functions for generating diffs

function generateTableDiff(oldTables: DataModel["tables"], newTables: DataModel["tables"]): TableDiff {
	const oldTableMap = new Map(oldTables.map((t) => [t.name, t]));
	const newTableMap = new Map(newTables.map((t) => [t.name, t]));

	const added = newTables.filter((t) => !oldTableMap.has(t.name));
	const removed = oldTables.filter((t) => !newTableMap.has(t.name));
	const modified: TableModification[] = [];

	for (const newTable of newTables) {
		const oldTable = oldTableMap.get(newTable.name);
		if (!oldTable) continue;

		const fieldChanges = generateFieldDiff(oldTable.fields, newTable.fields);
		const accessControlChanged = !deepEqual(oldTable.accessControl, newTable.accessControl);

		if (
			fieldChanges.fieldsAdded.length > 0 ||
			fieldChanges.fieldsRemoved.length > 0 ||
			fieldChanges.fieldsModified.length > 0 ||
			accessControlChanged
		) {
			modified.push({
				tableName: newTable.name,
				...fieldChanges,
				accessControlChanged,
			});
		}
	}

	return { added, removed, modified };
}

function generateFieldDiff(oldFields: Field[], newFields: Field[]) {
	const oldFieldMap = new Map(oldFields.map((f) => [f.name, f]));
	const newFieldMap = new Map(newFields.map((f) => [f.name, f]));

	const fieldsAdded = newFields.filter((f) => !oldFieldMap.has(f.name));
	const fieldsRemoved = oldFields.filter((f) => !newFieldMap.has(f.name));
	const fieldsModified: Array<{ field: Field; changes: FieldChange }> = [];

	for (const newField of newFields) {
		const oldField = oldFieldMap.get(newField.name);
		if (!oldField) continue;

		const changes: FieldChange = {};

		if (oldField.type !== newField.type) changes.type = { from: oldField.type, to: newField.type };
		if (oldField.nonNullable !== newField.nonNullable)
			changes.nonNullable = { from: oldField.nonNullable ?? false, to: newField.nonNullable ?? false };
		if (oldField.primaryKey !== newField.primaryKey)
			changes.primaryKey = { from: oldField.primaryKey ?? false, to: newField.primaryKey ?? false };

		if (!deepEqual(oldField.default, newField.default)) changes.default = { from: oldField.default, to: newField.default };

		if (!deepEqual(oldField.foreignKey, newField.foreignKey))
			changes.foreignKey = { from: oldField.foreignKey, to: newField.foreignKey };

		if (Object.keys(changes).length > 0) fieldsModified.push({ field: newField, changes });
	}

	return { fieldsAdded, fieldsRemoved, fieldsModified };
}

// SQL Generation Functions

function generateAccessControlDiff(oldTables: DataModel["tables"], newTables: DataModel["tables"]): AccessControlDiff {
	const oldTableMap = new Map(oldTables.map((t) => [t.name, t]));
	const tables: Array<{
		tableName: string;
		changes: AccessControlChange;
	}> = [];

	for (const newTable of newTables) {
		const oldTable = oldTableMap.get(newTable.name);
		if (!oldTable) {
			// New table, all access control is "added"
			// Use a default permissive condition for the "from" state
			const defaultCondition: Condition = true;
			tables.push({
				tableName: newTable.name,
				changes: {
					read: { from: defaultCondition, to: newTable.accessControl.read },
					create: { from: defaultCondition, to: newTable.accessControl.create },
					update: { from: defaultCondition, to: newTable.accessControl.update },
					delete: { from: defaultCondition, to: newTable.accessControl.delete },
				},
			});
			continue;
		}

		const changes: AccessControlChange = {};

		if (!deepEqual(oldTable.accessControl.read, newTable.accessControl.read)) {
			changes.read = { from: oldTable.accessControl.read, to: newTable.accessControl.read };
		}

		if (!deepEqual(oldTable.accessControl.create, newTable.accessControl.create)) {
			changes.create = { from: oldTable.accessControl.create, to: newTable.accessControl.create };
		}

		if (!deepEqual(oldTable.accessControl.update, newTable.accessControl.update)) {
			changes.update = { from: oldTable.accessControl.update, to: newTable.accessControl.update };
		}

		if (!deepEqual(oldTable.accessControl.delete, newTable.accessControl.delete)) {
			changes.delete = { from: oldTable.accessControl.delete, to: newTable.accessControl.delete };
		}

		if (Object.keys(changes).length > 0) {
			tables.push({
				tableName: newTable.name,
				changes,
			});
		}
	}

	return { tables };
}

function generateAccessControlDiffForFullMigration(tables: DataModel["tables"]): AccessControlDiff {
	const defaultCondition: Condition = true;
	return {
		tables: tables.map((table) => ({
			tableName: table.name,
			changes: {
				read: { from: defaultCondition, to: table.accessControl.read },
				create: { from: defaultCondition, to: table.accessControl.create },
				update: { from: defaultCondition, to: table.accessControl.update },
				delete: { from: defaultCondition, to: table.accessControl.delete },
			},
		})),
	};
}

// SQL Generation Functions

function mapFieldTypeToSQL(fieldType: string, dialect: Dialect): string {
	const typeMap = {
		[Dialect.POSTGRESQL]: {
			string: "TEXT",
			number: "NUMERIC",
			boolean: "BOOLEAN",
			object: "JSONB",
			date: "DATE",
			datetime: "TIMESTAMP WITH TIME ZONE",
			uuid: "UUID",
		},
		[Dialect.SQLITE_MINIMAL]: {
			string: "TEXT",
			number: "REAL",
			boolean: "INTEGER",
			object: "TEXT", // SQLite doesn't have native JSON type
			date: "TEXT",
			datetime: "TEXT",
			uuid: "TEXT",
		},
		[Dialect.SQLITE_EXTENSIONS]: {
			string: "TEXT",
			number: "REAL",
			boolean: "INTEGER",
			object: "JSON", // SQLite with extensions has JSON type
			date: "TEXT",
			datetime: "TEXT",
			uuid: "TEXT",
		},
	};

	return typeMap[dialect][fieldType as keyof (typeof typeMap)[typeof dialect]] || "TEXT";
}

function generateCreateTableSQL(table: DataModel["tables"][number], dialect: Dialect): string {
	const columns = table.fields.map((field) => {
		const parts = [`"${field.name}"`, mapFieldTypeToSQL(field.type, dialect)];

		if (field.primaryKey) parts.push("PRIMARY KEY");
		if (field.nonNullable && !field.primaryKey) parts.push("NOT NULL");
		if (field.default !== undefined) parts.push(`DEFAULT ${formatDefaultValue(field.default, dialect)}`);

		return `  ${parts.join(" ")}`;
	});

	// For SQLite, add foreign key constraints inline
	const foreignKeys: string[] = [];
	if (dialect === Dialect.SQLITE_MINIMAL || dialect === Dialect.SQLITE_EXTENSIONS) {
		for (const field of table.fields) {
			if (field.foreignKey) {
				let foreignKeyClause = `  FOREIGN KEY ("${field.name}") REFERENCES "${field.foreignKey.table}" ("${field.foreignKey.field}")`;

				if (field.foreignKey.onDelete)
					foreignKeyClause += ` ON DELETE ${field.foreignKey.onDelete.toUpperCase().replace(" ", " ")}`;
				if (field.foreignKey.onUpdate)
					foreignKeyClause += ` ON UPDATE ${field.foreignKey.onUpdate.toUpperCase().replace(" ", " ")}`;
				foreignKeys.push(foreignKeyClause);
			}
		}
	}

	const allColumns = [...columns, ...foreignKeys];
	const sql = `CREATE TABLE "${table.name}" (\n${allColumns.join(",\n")}\n);`;

	if (dialect === Dialect.POSTGRESQL) return `${sql}\n\nALTER TABLE "${table.name}" ENABLE ROW LEVEL SECURITY;`;
	return sql;
}

function generateAddColumnSQL(tableName: string, field: Field, dialect: Dialect): string {
	const parts = [`ALTER TABLE "${tableName}"`, "ADD COLUMN", `"${field.name}"`, mapFieldTypeToSQL(field.type, dialect)];

	if (field.nonNullable) {
		parts.push("NOT NULL");
	}

	if (field.default !== undefined) {
		parts.push(`DEFAULT ${formatDefaultValue(field.default, dialect)}`);
	}

	return `${parts.join(" ")};`;
}
function generateAlterColumnSQL(tableName: string, field: Field, changes: FieldChange, dialect: Dialect): string {
	const sqlParts: string[] = [];

	if (changes.type) {
		const newType = mapFieldTypeToSQL(changes.type.to, dialect);
		if (dialect === Dialect.POSTGRESQL) {
			sqlParts.push(`ALTER TABLE "${tableName}" ALTER COLUMN "${field.name}" TYPE ${newType};`);
		} else {
			const newColumnName = `${field.name}_${Date.now()}_new`;
			sqlParts.push(`ALTER TABLE "${tableName}" ADD COLUMN "${newColumnName}" ${newType};`);
			sqlParts.push(`UPDATE "${tableName}" SET "${newColumnName}" = CAST("${field.name}" AS ${newType});`);
			sqlParts.push(`ALTER TABLE "${tableName}" DROP COLUMN "${field.name}";`);
			sqlParts.push(`ALTER TABLE "${tableName}" RENAME COLUMN "${newColumnName}" TO "${field.name}";`);
		}
	}

	if (changes.nonNullable) {
		if (dialect === Dialect.POSTGRESQL) {
			const constraint = changes.nonNullable.to ? "SET NOT NULL" : "DROP NOT NULL";
			sqlParts.push(`ALTER TABLE "${tableName}" ALTER COLUMN "${field.name}" ${constraint};`);
		}
	}

	if (changes.default) {
		if (dialect === Dialect.POSTGRESQL) {
			if (changes.default.to === undefined) {
				sqlParts.push(`ALTER TABLE "${tableName}" ALTER COLUMN "${field.name}" DROP DEFAULT;`);
			} else {
				sqlParts.push(
					`ALTER TABLE "${tableName}" ALTER COLUMN "${field.name}" SET DEFAULT ${formatDefaultValue(changes.default.to, dialect)};`,
				);
			}
		}
	}

	return sqlParts.join("\n");
}

// Only PostgreSQL
function generateRLSPoliciesSQL(accessControlDiff: AccessControlDiff, model: DataModel): string[] {
	const sqlParts: string[] = [];

	for (const table of accessControlDiff.tables) {
		const tableName = table.tableName;

		// Drop existing policies first
		sqlParts.push(`DROP POLICY IF EXISTS "${tableName}_read_policy" ON "${tableName}";`);
		sqlParts.push(`DROP POLICY IF EXISTS "${tableName}_create_policy" ON "${tableName}";`);
		sqlParts.push(`DROP POLICY IF EXISTS "${tableName}_update_policy" ON "${tableName}";`);
		sqlParts.push(`DROP POLICY IF EXISTS "${tableName}_delete_policy" ON "${tableName}";`);

		const config = createParserConfig(model, Dialect.POSTGRESQL);
		const state = { rootTable: tableName, expressions: new ExpressionTypeMap(), config };

		// Create new policies
		if (table.changes.read) {
			const condition = parseCondition(table.changes.read.to, state);
			sqlParts.push(`CREATE POLICY "${tableName}_read_policy" ON "${tableName}" FOR SELECT USING (${condition});`);
		}

		if (table.changes.create) {
			const condition = parseCondition(table.changes.create.to, state);
			sqlParts.push(`CREATE POLICY "${tableName}_create_policy" ON "${tableName}" FOR INSERT WITH CHECK (${condition});`);
		}

		if (table.changes.update) {
			const condition = parseCondition(table.changes.update.to, state);
			sqlParts.push(`CREATE POLICY "${tableName}_update_policy" ON "${tableName}" FOR UPDATE USING (${condition});`);
		}

		if (table.changes.delete) {
			const condition = parseCondition(table.changes.delete.to, state);
			sqlParts.push(`CREATE POLICY "${tableName}_delete_policy" ON "${tableName}" FOR DELETE USING (${condition});`);
		}
	}

	return sqlParts;
}

// Helper function to map our field types to parser field types
function mapFieldType(fieldType: string): (typeof fieldTypes)[number] {
	switch (fieldType.toLowerCase()) {
		case "text":
		case "string":
		case "varchar":
		case "char":
			return "string";
		case "int":
		case "integer":
		case "bigint":
		case "smallint":
		case "decimal":
		case "numeric":
		case "real":
		case "double":
		case "float":
			return "number";
		case "bool":
		case "boolean":
			return "boolean";
		case "json":
		case "jsonb":
			return "object";
		case "date":
			return "date";
		case "datetime":
		case "timestamp":
		case "timestamptz":
			return "datetime";
		case "uuid":
			return "uuid";
		default:
			return "string"; // Default fallback
	}
}

// Helper function to create parser configuration from data model
function createParserConfig(model: DataModel, dialect: Dialect): Config {
	return {
		tables: model.tables.reduce<Config["tables"]>((acc, table) => {
			acc[table.name] = {
				allowedFields: table.fields.map((field) => ({
					name: field.name,
					type: mapFieldType(field.type),
					nullable: !field.nonNullable,
					default: field.default,
				})),
			};
			return acc;
		}, {}),
		variables: {
			user_id: { $uuid: "550e8400-e29b-41d4-a716-446655440000" },
			// Add other common variables that might be used in access control
		},
		relationships: model.tables.flatMap((table) =>
			table.fields
				.filter((field) => field.foreignKey)
				.map((field) => ({
					table: table.name,
					field: field.name,
					toTable: field.foreignKey!.table,
					toField: field.foreignKey!.field,
					type: "many-to-one" as const,
				})),
		),
		dialect,
	};
}

// Helper function to normalize function expressions (convert lowercase to uppercase)
function normalizeExpression(expression: AnyExpression): AnyExpression {
	if (typeof expression === "object" && expression !== null && "$func" in expression) {
		const funcExpr = expression.$func as Record<string, AnyExpression[]>;
		const normalizedFunc: Record<string, AnyExpression[]> = {};

		for (const [funcName, args] of Object.entries(funcExpr)) {
			// Convert common lowercase function names to uppercase
			const normalizedName = funcName.toLowerCase() === "now" ? "NOW" : funcName.toUpperCase();
			normalizedFunc[normalizedName] = args.map((arg) => normalizeExpression(arg));
		}

		return { $func: normalizedFunc };
	}

	if (typeof expression === "object" && expression !== null && !Array.isArray(expression)) {
		const normalized: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(expression)) {
			normalized[key] = typeof value === "object" && value !== null ? normalizeExpression(value as AnyExpression) : value;
		}
		return normalized as AnyExpression;
	}

	return expression;
}

function formatDefaultValue(value: AnyExpression | undefined, dialect: Dialect, model?: DataModel): string {
	if (value === null || value === undefined) {
		return "NULL";
	}

	if (typeof value === "string") {
		return `'${value.replace(/'/g, "''")}'`;
	}

	if (typeof value === "number") {
		return String(value);
	}

	if (typeof value === "boolean") {
		// SQLite uses INTEGER for boolean, so convert boolean values appropriately
		if (dialect === Dialect.SQLITE_MINIMAL || dialect === Dialect.SQLITE_EXTENSIONS) return value ? "1" : "0";
		return String(value);
	}

	// For complex expressions, use parseExpression from json-to-sql-parser
	if (typeof value === "object") {
		try {
			// Normalize function names (e.g., "now" -> "NOW")
			const normalizedValue = normalizeExpression(value);
			const config = model ? createParserConfig(model, dialect) : { tables: {}, variables: {}, relationships: [], dialect };

			const state: ParserState = { config, rootTable: "", expressions: new ExpressionTypeMap() };
			const sql = parseExpression(normalizedValue, state);

			// Fix SQLite-specific function issues
			if ((dialect === Dialect.SQLITE_MINIMAL || dialect === Dialect.SQLITE_EXTENSIONS) && sql === "DATETIME()") {
				return "CURRENT_TIMESTAMP";
			}

			return sql;
		} catch (error) {
			throw new Error(`Failed to parse expression: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	return String(value);
}

// Utility functions

function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a == null || b == null) return false;
	if (typeof a !== typeof b) return false;

	if (typeof a === "object") {
		const keysA = Object.keys(a as Record<string, unknown>);
		const keysB = Object.keys(b as Record<string, unknown>);

		if (keysA.length !== keysB.length) return false;

		for (const key of keysA) {
			if (!keysB.includes(key)) return false;
			if (!deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
		}

		return true;
	}

	return false;
}

// Export schemas and types
export { dataModelSchema } from "./schemas";
