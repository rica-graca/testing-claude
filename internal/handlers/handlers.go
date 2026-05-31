package handlers

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/yourname/timewaste/internal/db"
	"github.com/yourname/timewaste/internal/models"
	"github.com/yourname/timewaste/internal/reclamation"
)

type Handler struct {
	tasks      *db.TaskRepo
	categories *db.CategoryRepo
}

func NewRouter(pool *pgxpool.Pool) http.Handler {
	h := &Handler{
		tasks:      db.NewTaskRepo(pool),
		categories: db.NewCategoryRepo(pool),
	}

	r := chi.NewRouter()
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(middleware.RequestID)
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins: []string{"*"},
		AllowedMethods: []string{"GET", "POST", "PATCH", "DELETE", "OPTIONS"},
		AllowedHeaders: []string{"Content-Type"},
	}))

	// Static dashboard
	r.Handle("/", http.FileServer(http.Dir("web/static")))
	r.Handle("/static/*", http.StripPrefix("/static/", http.FileServer(http.Dir("web/static"))))

	// API routes
	r.Route("/api", func(r chi.Router) {
		// Tasks
		r.Get("/tasks", h.ListTasks)
		r.Post("/tasks", h.CreateTask)
		r.Get("/tasks/{id}", h.GetTask)
		r.Patch("/tasks/{id}", h.UpdateTask)
		r.Delete("/tasks/{id}", h.DeleteTask)
		r.Post("/tasks/{id}/start", h.StartTask)
		r.Post("/tasks/{id}/stop", h.StopTask)

		// Categories
		r.Get("/categories", h.ListCategories)
		r.Post("/categories", h.CreateCategory)
		r.Delete("/categories/{id}", h.DeleteCategory)

		// Reports
		r.Get("/report", h.GetReport)
	})

	return r
}

// ── Tasks ──────────────────────────────────────────────────────────────────

func (h *Handler) ListTasks(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	var categoryID, onlyWaste *string
	var from, to *time.Time

	if v := q.Get("category_id"); v != "" {
		categoryID = &v
	}
	if v := q.Get("is_waste"); v != "" {
		onlyWaste = &v
	}
	if v := q.Get("from"); v != "" {
		t, err := time.Parse("2006-01-02", v)
		if err == nil {
			from = &t
		}
	}
	if v := q.Get("to"); v != "" {
		t, err := time.Parse("2006-01-02", v)
		if err == nil {
			to = &t
		}
	}

	var waste *bool
	if onlyWaste != nil {
		b := *onlyWaste == "true"
		waste = &b
	}

	tasks, err := h.tasks.List(r.Context(), categoryID, waste, from, to)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, tasks)
}

func (h *Handler) GetTask(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	task, err := h.tasks.Get(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusNotFound, "task not found")
		return
	}
	writeJSON(w, http.StatusOK, task)
}

func (h *Handler) CreateTask(w http.ResponseWriter, r *http.Request) {
	var req models.CreateTaskRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if req.Title == "" {
		writeError(w, http.StatusBadRequest, "title is required")
		return
	}
	task, err := h.tasks.Create(r.Context(), req)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, task)
}

func (h *Handler) UpdateTask(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var req models.UpdateTaskRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	task, err := h.tasks.Update(r.Context(), id, req)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, task)
}

func (h *Handler) DeleteTask(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := h.tasks.Delete(r.Context(), id); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) StartTask(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	task, err := h.tasks.Start(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, task)
}

func (h *Handler) StopTask(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	task, err := h.tasks.Stop(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	// Build response with reclamation suggestions if this is a waste task
	response := models.StopTaskResponse{
		Task: task,
	}

	// If task is marked as waste and has duration, calculate suggestions
	if task.IsWaste && task.DurationSec != nil && *task.DurationSec > 0 {
		suggestions := reclamation.Calculate(*task.DurationSec)
		response.ReclamationSuggestions = make([]models.ReclamationSuggestion, len(suggestions))
		for i, s := range suggestions {
			response.ReclamationSuggestions[i] = models.ReclamationSuggestion{
				Activity: s.Activity,
				Count:    s.Count,
				Unit:     s.Unit,
				Message:  s.Message,
			}
		}
	}

	writeJSON(w, http.StatusOK, response)
}

// ── Categories ─────────────────────────────────────────────────────────────

func (h *Handler) ListCategories(w http.ResponseWriter, r *http.Request) {
	cats, err := h.categories.List(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, cats)
}

func (h *Handler) CreateCategory(w http.ResponseWriter, r *http.Request) {
	var req models.CreateCategoryRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if req.Name == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}
	if req.Color == "" {
		req.Color = "#6366f1"
	}
	cat, err := h.categories.Create(r.Context(), req)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, cat)
}

func (h *Handler) DeleteCategory(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := h.categories.Delete(r.Context(), id); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ── Reports ────────────────────────────────────────────────────────────────

func (h *Handler) GetReport(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	var from, to *time.Time

	if v := q.Get("from"); v != "" {
		t, err := time.Parse("2006-01-02", v)
		if err == nil {
			from = &t
		}
	}
	if v := q.Get("to"); v != "" {
		t, err := time.Parse("2006-01-02", v)
		if err == nil {
			to = &t
		}
	}

	report, err := h.tasks.Report(r.Context(), from, to)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, report)
}

// ── Helpers ────────────────────────────────────────────────────────────────

func writeJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

func writeError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": message})
}
