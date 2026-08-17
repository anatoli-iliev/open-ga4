import type { FilterExpression } from "./client.js";
/**
 * A small filter vocabulary for the `query` command.
 *
 * Deliberately narrower than the API's full `FilterExpression` tree. A model
 * composing nested and/or/not groups from a free-form schema gets it wrong
 * often; a flat list of conditions combined with AND covers what people
 * actually ask for and can be validated completely before a request is spent.
 *
 * A filter that cannot be built raises. It is never silently dropped; a
 * filtered question that quietly returns whole-site numbers is worse than an
 * error, because the number looks right.
 */
export declare const FILTER_OPERATORS: readonly ["contains", "exact", "begins_with", "ends_with", "regex", "in_list", "greater_than", "less_than"];
export type FilterOperator = (typeof FILTER_OPERATORS)[number];
export type FilterCondition = {
    field: string;
    op: FilterOperator;
    value: string;
};
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
export declare function buildFilters(conditions: readonly FilterCondition[], metrics: readonly string[]): BuiltFilters;
