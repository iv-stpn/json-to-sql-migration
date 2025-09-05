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
						foreignKey: z
							.object({
								table: z.string(),
								field: z.string(),
								onDelete: z.enum(["cascade", "restrict", "set_null"]).optional(),
								onUpdate: z.enum(["cascade", "restrict", "set_null"]).optional(),
							})
							.strict()
							.optional(),
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
	})
	.strict();
