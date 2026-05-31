package db

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/yourname/timewaste/internal/models"
)

type CategoryRepo struct {
	pool *pgxpool.Pool
}

func NewCategoryRepo(pool *pgxpool.Pool) *CategoryRepo {
	return &CategoryRepo{pool: pool}
}

func (r *CategoryRepo) List(ctx context.Context) ([]models.Category, error) {
	rows, err := r.pool.Query(ctx, `SELECT id, name, color, created_at FROM category ORDER name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var cats []models.Category
	for rows.Next() {
		var c models.Category
		if err := rows.Scan(&c.ID, &c.Name, &c.Color, &c.CreatedAt); err != nil {
			return nil, err
		}
		cats = append(cats, c)
	}
	return cats, rows.Err()
}

func (r *CategoryRepo) Create(ctx context.Context, req models.CreateCategoryRequest) (*models.Category, error) {
	var c models.Category
	err := r.pool.QueryRow(ctx,
		`INSERT INTO categories (name, color) VALUES ($1, $2) RETURNING id, name, color, created_at`,
		req.Name, req.Color,
	).Scan(&c.ID, &c.Name, &c.Color, &c.CreatedAt)
	return &c, err
}

func (r *CategoryRepo) Delete(ctx context.Context, id string) error {
	_, err := r.pool.Exec(ctx, `DELETE FROM categories WHERE id = $1`, id)
	return err
}
