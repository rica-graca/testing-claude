package db

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/yourname/timewaste/internal/models"
)

type TaskRepo struct {
	pool *pgxpool.Pool
}

func NewTaskRepo(pool *pgxpool.Pool) *TaskRepo {
	return &TaskRepo{pool: pool}
}

func (r *TaskRepo) List(ctx context.Context, categoryID *string, onlyWaste *bool, from, to *time.Time) ([]models.Task, error) {
	q := `
		SELECT t.id, t.title, t.description, t.category_id,
		       c.name, c.color,
		       t.started_at, t.ended_at, t.duration_sec,
		       t.is_waste, t.notes, t.created_at
		FROM tasks t
		LEFT JOIN categories c ON c.id = t.category_id
		WHERE 1=1`
	args := []any{}
	i := 1

	if categoryID != nil {
		q += fmt.Sprintf(" AND t.category_id = $%d", i)
		args = append(args, *categoryID)
		i++
	}
	if onlyWaste != nil {
		q += fmt.Sprintf(" AND t.is_waste = $%d", i)
		args = append(args, *onlyWaste)
		i++
	}
	if from != nil {
		q += fmt.Sprintf(" AND t.started_at >= $%d", i)
		args = append(args, *from)
		i++
	}
	if to != nil {
		q += fmt.Sprintf(" AND t.started_at <= $%d", i)
		args = append(args, *to)
		i++
	}
	q += " ORDER BY t.created_at DESC"
	_ = i

	rows, err := r.pool.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var tasks []models.Task
	for rows.Next() {
		var t models.Task
		var cat models.Category
		var catID, catName, catColor *string
		if err := rows.Scan(
			&t.ID, &t.Title, &t.Description, &catID,
			&catName, &catColor,
			&t.StartedAt, &t.EndedAt, &t.DurationSec,
			&t.IsWaste, &t.Notes, &t.CreatedAt,
		); err != nil {
			return nil, err
		}
		if catID != nil {
			cat.ID = *catID
			cat.Name = *catName
			cat.Color = *catColor
			t.Category = &cat
			t.CategoryID = catID
		}
		tasks = append(tasks, t)
	}
	return tasks, rows.Err()
}

func (r *TaskRepo) Get(ctx context.Context, id string) (*models.Task, error) {
	q := `
		SELECT t.id, t.title, t.description, t.category_id,
		       c.name, c.color,
		       t.started_at, t.ended_at, t.duration_sec,
		       t.is_waste, t.notes, t.created_at
		FROM tasks t
		LEFT JOIN categories c ON c.id = t.category_id
		WHERE t.id = $1`

	var t models.Task
	var cat models.Category
	var catID, catName, catColor *string
	err := r.pool.QueryRow(ctx, q, id).Scan(
		&t.ID, &t.Title, &t.Description, &catID,
		&catName, &catColor,
		&t.StartedAt, &t.EndedAt, &t.DurationSec,
		&t.IsWaste, &t.Notes, &t.CreatedAt,
	)
	if err != nil {
		return nil, err
	}
	if catID != nil {
		cat.ID = *catID
		cat.Name = *catName
		cat.Color = *catColor
		t.Category = &cat
		t.CategoryID = catID
	}
	return &t, nil
}

func (r *TaskRepo) Create(ctx context.Context, req models.CreateTaskRequest) (*models.Task, error) {
	q := `
		INSERT INTO tasks (title, description, category_id, is_waste, notes)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id, created_at`

	var t models.Task
	t.Title = req.Title
	t.Description = req.Description
	t.CategoryID = req.CategoryID
	t.IsWaste = req.IsWaste
	t.Notes = req.Notes

	err := r.pool.QueryRow(ctx, q,
		req.Title, req.Description, req.CategoryID, req.IsWaste, req.Notes,
	).Scan(&t.ID, &t.CreatedAt)
	return &t, err
}

func (r *TaskRepo) Update(ctx context.Context, id string, req models.UpdateTaskRequest) (*models.Task, error) {
	setClauses := []string{}
	args := []any{}
	i := 1

	if req.Title != nil {
		setClauses = append(setClauses, fmt.Sprintf("title = $%d", i))
		args = append(args, *req.Title)
		i++
	}
	if req.Description != nil {
		setClauses = append(setClauses, fmt.Sprintf("description = $%d", i))
		args = append(args, *req.Description)
		i++
	}
	if req.CategoryID != nil {
		setClauses = append(setClauses, fmt.Sprintf("category_id = $%d", i))
		args = append(args, *req.CategoryID)
		i++
	}
	if req.IsWaste != nil {
		setClauses = append(setClauses, fmt.Sprintf("is_waste = $%d", i))
		args = append(args, *req.IsWaste)
		i++
	}
	if req.Notes != nil {
		setClauses = append(setClauses, fmt.Sprintf("notes = $%d", i))
		args = append(args, *req.Notes)
		i++
	}
	if len(setClauses) == 0 {
		return r.Get(ctx, id)
	}

	args = append(args, id)
	q := fmt.Sprintf("UPDATE tasks SET %s WHERE id = $%d", strings.Join(setClauses, ", "), i)
	if _, err := r.pool.Exec(ctx, q, args...); err != nil {
		return nil, err
	}
	return r.Get(ctx, id)
}

func (r *TaskRepo) Start(ctx context.Context, id string) (*models.Task, error) {
	q := `UPDATE tasks SET started_at = NOW() WHERE id = $1 AND started_at IS NULL`
	if _, err := r.pool.Exec(ctx, q, id); err != nil {
		return nil, err
	}
	return r.Get(ctx, id)
}

func (r *TaskRepo) Stop(ctx context.Context, id string) (*models.Task, error) {
	q := `UPDATE tasks SET ended_at = NOW() WHERE id = $1 AND started_at IS NOT NULL AND ended_at IS NULL`
	if _, err := r.pool.Exec(ctx, q, id); err != nil {
		return nil, err
	}
	return r.Get(ctx, id)
}

func (r *TaskRepo) Delete(ctx context.Context, id string) error {
	_, err := r.pool.Exec(ctx, `DELETE FROM tasks WHERE id = $1`, id)
	return err
}

func (r *TaskRepo) WasteReport(ctx context.Context, from, to time.Time) (*models.WasteReport, error) {
	q := `
		SELECT
			COALESCE(c.id::text, 'uncategorized'),
			COALESCE(c.name, 'Uncategorized'),
			COALESCE(c.color, '#94a3b8'),
			COALESCE(SUM(t.duration_sec), 0)::int AS total_sec,
			COALESCE(SUM(CASE WHEN t.is_waste THEN t.duration_sec ELSE 0 END), 0)::int AS waste_sec,
			COUNT(t.id)::int AS task_count
		FROM tasks t
		LEFT JOIN categories c ON c.id = t.category_id
		WHERE t.started_at >= $1 AND t.ended_at <= $2 AND t.duration_sec IS NOT NULL
		GROUP BY c.id, c.name, c.color
		ORDER BY waste_sec DESC`

	rows, err := r.pool.Query(ctx, q, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	report := &models.WasteReport{Period: from.Format("2006-01-02")}
	for rows.Next() {
		var cr models.CategoryReport
		if err := rows.Scan(&cr.CategoryID, &cr.CategoryName, &cr.Color, &cr.TotalSec, &cr.WasteSec, &cr.TaskCount); err != nil {
			return nil, err
		}
		report.TotalSec += cr.TotalSec
		report.WasteSec += cr.WasteSec
		report.ByCategory = append(report.ByCategory, cr)
	}
	if report.TotalSec > 0 {
		report.WastePct = float64(report.WasteSec) / float64(report.TotalSec) * 100
	}
	return report, rows.Err()
}
