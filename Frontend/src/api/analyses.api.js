import { get, getBlob } from './client';

export const list = (params) => get('/analyses', params);
export const getDetail = (id) => get(`/analyses/${id}`);
export const getImage = (id) => getBlob(`/analyses/${id}/image`);
