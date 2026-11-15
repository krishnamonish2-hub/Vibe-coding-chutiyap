-- Phase 3 decision: dish display names are unique, ignoring upper/lower case, so admin and student screens stay
-- unambiguous. The ML service never sees display names (it always receives the immutable ml_dish_name).
CREATE UNIQUE INDEX dishes_display_name_unique ON dishes (lower(display_name));
