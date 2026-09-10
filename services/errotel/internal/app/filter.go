package app

import (
	"regexp"
	"strings"
)

const (
	maxFilterDepth = 12
	filterOrigin   = "origin"
	filterNot      = "not"
	filterExists   = "exists"
)

func filterField(name string) string {
	switch name {
	case "message":
		return "exceptionMessage"
	case "service", "environment", "exceptionType", "release", "traceId", "runtimeId", "groupKey", filterOrigin:
		return name
	default:
		return ""
	}
}

func validateFilter(filter *SearchFilter, depth int, budget *int) error {
	*budget--
	if depth > maxFilterDepth || *budget < 0 {
		return requestError("filter_budget_exceeded")
	}

	if filter.Op == "and" || filter.Op == "or" || filter.Op == filterNot {
		return validateFilterGroup(filter, depth, budget)
	}

	if len(filter.Children) != 0 || filterField(filter.Field) == "" {
		return requestError("invalid_filter_field")
	}

	if filter.Op == filterExists {
		if filter.Value != nil {
			return requestError("invalid_exists_filter")
		}

		return nil
	}

	return validateFilterValue(filter)
}

func validateFilterValue(filter *SearchFilter) error {
	if filter.Value == nil || len(*filter.Value) > maxFilterLength {
		return requestError("invalid_filter_value")
	}

	switch filter.Op {
	case "eq":
		if filter.Field == filterOrigin && *filter.Value != originSDK && *filter.Value != originOTel {
			return requestError("invalid_origin")
		}
	case "contains", "icontains", "prefix":
		if filter.Field == filterOrigin {
			return requestError("invalid_origin_operator")
		}
	default:
		return requestError("invalid_filter_operator")
	}

	return nil
}

func validateFilterGroup(filter *SearchFilter, depth int, budget *int) error {
	if filter.Field != "" || filter.Value != nil || len(filter.Children) == 0 {
		return requestError("invalid_filter_group")
	}

	if filter.Op == filterNot && len(filter.Children) != 1 {
		return requestError("invalid_not_filter")
	}

	for i := range filter.Children {
		if err := validateFilter(&filter.Children[i], depth+1, budget); err != nil {
			return err
		}
	}

	return nil
}

func (a *App) filterQuery(filter *SearchFilter) string {
	if filter.Op == filterNot {
		return "NOT (" + a.filterQuery(&filter.Children[0]) + ")"
	}

	if filter.Op == "and" || filter.Op == "or" {
		parts := make([]string, len(filter.Children))
		for i := range filter.Children {
			parts[i] = "(" + a.filterQuery(&filter.Children[i]) + ")"
		}

		return strings.Join(parts, " "+strings.ToUpper(filter.Op)+" ")
	}

	if filter.Field == filterOrigin {
		if filter.Op == filterExists {
			return "*"
		}

		sdk := a.exact("kind", "exception")
		if *filter.Value == originSDK {
			return sdk
		}

		return "NOT (" + sdk + ")"
	}

	field := filterField(filter.Field)
	if filter.Op == filterExists {
		// VictoriaLogs represents missing and empty stored fields identically.
		return a.field(field) + ":*"
	}

	if filter.Op == "eq" {
		return a.exact(field, *filter.Value)
	}

	pattern := regexp.QuoteMeta(*filter.Value)
	if filter.Op == "prefix" {
		pattern = "^" + pattern
	}

	if filter.Op == "icontains" {
		pattern = "(?i)" + pattern
	}

	return a.field(field) + ":~" + quote(pattern)
}

func validateSearchFilter(filter *SearchFilter) error {
	if filter == nil {
		return nil
	}

	budget := 64

	return validateFilter(filter, 0, &budget)
}
