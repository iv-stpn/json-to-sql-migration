import { anyExpressionSchema, conditionSchema, fieldTypes } from "json-to-sql-parser";
import { z } from "zod";

export const dataModelSchema = z
	.object({
		tables: z.array(
			z.object({
				name: z.string(),
				fields: z.array(
					z.object({
						name: z.string(),
						type: z.enum(fieldTypes),
						nonNullable: z.boolean().optional(),
						primaryKey: z.boolean().optional(),
						default: anyExpressionSchema.optional(),
					}),
				),
				accessControl: z.object({
					read: conditionSchema,
					create: conditionSchema,
					update: conditionSchema,
					delete: conditionSchema,
				}),
			}),
		),
		relationships: z.array(
			z.object({
				name: z.string(),
				fromTable: z.string(),
				toTable: z.string(),
				type: z.enum(["one-to-one", "many-to-one"]),
				onDelete: z.enum(["cascade", "restrict", "set null"]).optional(),
				onUpdate: z.enum(["cascade", "restrict", "set null"]).optional(),
			}),
		),
	})
	.strict();
