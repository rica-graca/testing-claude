package models

import "time"

type Category struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Color     string    `json:"color"`
	CreatedAt time.Time `json:"created_at"`
}

type Task struct {
	ID          string     `json:"id"`
	Title       string     `json:"title"`
	Description *string    `json:"description,omitempty"`
	CategoryID  *string    `json:"category_id,omitempty"`
	Category    *Category  `json:"category,omitempty"`
	StartedAt   *time.Time `json:"started_at,omitempty"`
	EndedAt     *time.Time `json:"ended_at,omitempty"`
	DurationSec *int       `json:"duration_sec,omitempty"`
	IsWaste     bool       `json:"is_waste"`
	Notes       *string    `json:"notes,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
}

// IsRunning returns true if the task has been started but not finished.
func (t *Task) IsRunning() bool {
	return t.StartedAt != nil && t.EndedAt == nil
}

// WasteReport aggregates wasted time per category.
type WasteReport struct {
	Period      string            `json:"period"` // e.g. "2024-05-01"
	TotalSec    int               `json:"total_sec"`
	WasteSec    int               `json:"waste_sec"`
	WastePct    float64           `json:"waste_pct"`
	ByCategory  []CategoryReport  `json:"by_category"`
}

type CategoryReport struct {
	CategoryID   string  `json:"category_id"`
	CategoryName string  `json:"category_name"`
	Color        string  `json:"color"`
	TotalSec     int     `json:"total_sec"`
	WasteSec     int     `json:"waste_sec"`
	TaskCount    int     `json:"task_count"`
}

// CreateTaskRequest is the body for POST /tasks.
type CreateTaskRequest struct {
	Title       string  `json:"title"`
	Description *string `json:"description"`
	CategoryID  *string `json:"category_id"`
	IsWaste     bool    `json:"is_waste"`
	Notes       *string `json:"notes"`
}

// UpdateTaskRequest is the body for PATCH /tasks/:id.
type UpdateTaskRequest struct {
	Title       *string `json:"title"`
	Description *string `json:"description"`
	CategoryID  *string `json:"category_id"`
	IsWaste     *bool   `json:"is_waste"`
	Notes       *string `json:"notes"`
}

type CreateCategoryRequest struct {
	Name  string `json:"name"`
	Color string `json:"color"`
}
