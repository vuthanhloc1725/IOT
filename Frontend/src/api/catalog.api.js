import { del, get, patch, post } from './client';

export const listDiseases = () => get('/diseases');
export const getDisease = (id) => get(`/diseases/${id}`);
export const createDisease = (payload) => post('/diseases', payload);
export const updateDisease = (id, payload) => patch(`/diseases/${id}`, payload);
export const deleteDisease = (id) => del(`/diseases/${id}`);

export const listTreatments = (params) => get('/treatments', params);
export const createTreatment = (payload) => post('/treatments', payload);
export const updateTreatment = (id, payload) => patch(`/treatments/${id}`, payload);
export const deleteTreatment = (id) => del(`/treatments/${id}`);
