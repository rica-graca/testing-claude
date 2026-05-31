package reclamation

// Activity represents an alternative productive activity
type Activity struct {
	Name        string `json:"name"`
	DurationSec int    `json:"duration_sec"` // How long one unit takes
	Unit        string `json:"unit"`         // e.g., "lesson", "km", "chapter"
}

// Suggestion represents a calculated suggestion based on wasted time
type Suggestion struct {
	Activity string  `json:"activity"`
	Count    float64 `json:"count"`
	Unit     string  `json:"unit"`
	Message  string  `json:"message"`
}

// DefaultActivities provides a list of common productive activities
var DefaultActivities = []Activity{
	{Name: "Spanish lesson", DurationSec: 1800, Unit: "lesson"},      // 30 min
	{Name: "walk", DurationSec: 900, Unit: "km"},                      // 15 min per km
	{Name: "meditation session", DurationSec: 600, Unit: "session"},   // 10 min
	{Name: "book chapter", DurationSec: 1200, Unit: "chapter"},        // 20 min
	{Name: "workout set", DurationSec: 300, Unit: "set"},              // 5 min
	{Name: "podcast episode", DurationSec: 2400, Unit: "episode"},     // 40 min
	{Name: "journal entry", DurationSec: 600, Unit: "entry"},          // 10 min
	{Name: "stretching routine", DurationSec: 900, Unit: "routine"},   // 15 min
	{Name: "coding tutorial", DurationSec: 1800, Unit: "tutorial"},    // 30 min
	{Name: "phone call with friend", DurationSec: 900, Unit: "call"},  // 15 min
}

// Calculate generates reclamation suggestions based on wasted duration
func Calculate(durationSec int) []Suggestion {
	if durationSec <= 0 {
		return []Suggestion{}
	}

	suggestions := []Suggestion{}

	for _, activity := range DefaultActivities {
		count := float64(durationSec) / float64(activity.DurationSec)
		
		// Only include if at least 0.5 of the activity could be done
		if count >= 0.5 {
			suggestion := Suggestion{
				Activity: activity.Name,
				Count:    count,
				Unit:     activity.Unit,
				Message:  formatMessage(activity.Name, count, activity.Unit),
			}
			suggestions = append(suggestions, suggestion)
		}
	}

	// Sort by count descending and limit to top suggestions
	suggestions = sortAndLimit(suggestions, 5)

	return suggestions
}

// formatMessage creates a human-readable message for the suggestion
func formatMessage(activity string, count float64, unit string) string {
	// Round to one decimal place for display
	if count >= 1 {
		wholeCount := int(count)
		if float64(wholeCount) == count {
			if wholeCount == 1 {
				return formatSingular(wholeCount, activity, unit)
			}
			return formatPlural(wholeCount, activity, unit)
		}
		return formatDecimal(count, activity, unit)
	}
	return formatDecimal(count, activity, unit)
}

func formatSingular(count int, activity, unit string) string {
	return sprintf("%d %s", count, activity)
}

func formatPlural(count int, activity, unit string) string {
	// Handle pluralization
	if activity == "Spanish lesson" {
		return sprintf("%d Spanish lessons", count)
	}
	if activity == "walk" {
		return sprintf("%d km walk", count)
	}
	if activity == "meditation session" {
		return sprintf("%d meditation sessions", count)
	}
	if activity == "book chapter" {
		return sprintf("%d book chapters", count)
	}
	if activity == "workout set" {
		return sprintf("%d workout sets", count)
	}
	if activity == "podcast episode" {
		return sprintf("%d podcast episodes", count)
	}
	if activity == "journal entry" {
		return sprintf("%d journal entries", count)
	}
	if activity == "stretching routine" {
		return sprintf("%d stretching routines", count)
	}
	if activity == "coding tutorial" {
		return sprintf("%d coding tutorials", count)
	}
	if activity == "phone call with friend" {
		return sprintf("%d phone calls with friends", count)
	}
	return sprintf("%d %ss", count, activity)
}

func formatDecimal(count float64, activity, unit string) string {
	if activity == "walk" {
		return sprintf("%.1f km walk", count)
	}
	return sprintf("%.1f %ss", count, activity)
}

func sprintf(format string, args ...interface{}) string {
	// Simple sprintf implementation
	result := format
	for _, arg := range args {
		switch v := arg.(type) {
		case int:
			result = replaceFirst(result, "%d", intToString(v))
		case float64:
			result = replaceFirst(result, "%.1f", floatToString(v))
		case string:
			result = replaceFirst(result, "%s", v)
		}
	}
	return result
}

func replaceFirst(s, old, new string) string {
	for i := 0; i <= len(s)-len(old); i++ {
		if s[i:i+len(old)] == old {
			return s[:i] + new + s[i+len(old):]
		}
	}
	return s
}

func intToString(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	digits := []byte{}
	for n > 0 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
		n /= 10
	}
	if neg {
		digits = append([]byte{'-'}, digits...)
	}
	return string(digits)
}

func floatToString(f float64) string {
	// Format to 1 decimal place
	whole := int(f)
	frac := int((f - float64(whole)) * 10 + 0.5)
	if frac >= 10 {
		whole++
		frac = 0
	}
	return intToString(whole) + "." + intToString(frac)
}

// sortAndLimit sorts suggestions by count descending and limits to n items
func sortAndLimit(suggestions []Suggestion, limit int) []Suggestion {
	// Simple bubble sort by count descending
	for i := 0; i < len(suggestions); i++ {
		for j := i + 1; j < len(suggestions); j++ {
			if suggestions[j].Count > suggestions[i].Count {
				suggestions[i], suggestions[j] = suggestions[j], suggestions[i]
			}
		}
	}

	if len(suggestions) > limit {
		return suggestions[:limit]
	}
	return suggestions
}
