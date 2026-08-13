import type { FilterExpression, MatchType } from "./client.js";
import { Ga4RequestError } from "./limits.js";

/**
 * A small filter vocabulary for `ga4_query`.
 *
 * Deliberately narrower than the API's full `FilterExpression` tree. A model
 * composing nested and/or/not groups from a free-form schema gets it wrong
 * often; a flat list of conditions combined with AND covers what people
 * actually ask for and can be validated completely before a request is spent.
 *
 * A filter that cannot be built raises. It is never silently dropped — a
 * filtered question that quietly returns whole-site numbers is worse than an
 * error, because the number looks right.
 */

export const FILTER_OPERATORS = [
  "contains",
  "exact",
  "begins_with",
  "ends_with",
  "regex",
  "in_list",
  "greater_than",
  "less_than",
] as const;

export type FilterOperator = (typeof FILTER_OPERATORS)[number];

export type FilterCondition = {
  field: string;
  op: FilterOperator;
  value: string;
};

const STRING_MATCH: Partial<Record<FilterOperator, MatchType>> = {
  contains: "CONTAINS",
  exact: "EXACT",
  begins_with: "BEGINS_WITH",
  ends_with: "ENDS_WITH",
  regex: "FULL_REGEXP",
};

const NUMERIC_OPERATION: Partial<Record<FilterOperator, string>> = {
  greater_than: "GREATER_THAN",
  less_than: "LESS_THAN",
};

function buildOne(condition: FilterCondition, isMetric: boolean): FilterExpression {
  const { field, op, value } = condition;

  const numericOperation = NUMERIC_OPERATION[op];
  if (numericOperation) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      throw new Ga4RequestError(
        "BAD_FILTER_VALUE",
        `Filter "${field} ${op} ${value}" needs a number, and "${value}" is not one.`,
      );
    }
    return {
      filter: {
        fieldName: field,
        numericFilter: { operation: numericOperation, value: { doubleValue: numeric } },
      },
    };
  }

  if (isMetric) {
    throw new Ga4RequestError(
      "BAD_FILTER_OPERATOR",
      `${field} is a metric, so it can only be filtered with greater_than or less_than, ` +
        `not "${op}". Filter a dimension by text instead, or compare the metric numerically.`,
    );
  }

  if (op === "in_list") {
    const values = value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (values.length === 0) {
      throw new Ga4RequestError(
        "BAD_FILTER_VALUE",
        `Filter "${field} in_list" needs a comma-separated list of values.`,
      );
    }
    return { filter: { fieldName: field, inListFilter: { values, caseSensitive: false } } };
  }

  if (op === "regex") {
    try {
      new RegExp(value);
    } catch (error) {
      throw new Ga4RequestError(
        "BAD_FILTER_VALUE",
        `Filter "${field} regex" is not a valid regular expression: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const matchType = STRING_MATCH[op];
  if (!matchType) {
    throw new Ga4RequestError(
      "BAD_FILTER_OPERATOR",
      `Unknown filter operator "${op}". Available: ${FILTER_OPERATORS.join(", ")}.`,
    );
  }

  return {
    filter: { fieldName: field, stringFilter: { matchType, value, caseSensitive: false } },
  };
}

export type BuiltFilters = {
  dimensionFilter?: FilterExpression;
  metricFilter?: FilterExpression;
  /** One line per condition, so the report says what it was narrowed to. */
  descriptions: string[];
};

/**
 * Split conditions into the dimension and metric filters the API expects, and
 * combine each side with AND.
 */
export function buildFilters(
  conditions: readonly FilterCondition[],
  metrics: readonly string[],
): BuiltFilters {
  const dimensionSide: FilterExpression[] = [];
  const metricSide: FilterExpression[] = [];
  const descriptions: string[] = [];

  for (const condition of conditions) {
    const isMetric = metrics.includes(condition.field);
    const expression = buildOne(condition, isMetric);
    (isMetric ? metricSide : dimensionSide).push(expression);
    descriptions.push(`${condition.field} ${condition.op.replace(/_/g, " ")} "${condition.value}"`);
  }

  const combine = (list: FilterExpression[]): FilterExpression | undefined => {
    if (list.length === 0) return undefined;
    if (list.length === 1) return list[0];
    return { andGroup: { expressions: list } };
  };

  return {
    ...(combine(dimensionSide) ? { dimensionFilter: combine(dimensionSide)! } : {}),
    ...(combine(metricSide) ? { metricFilter: combine(metricSide)! } : {}),
    descriptions,
  };
}
